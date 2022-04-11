import { App, debounce, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';

interface WaypointSettings {
	waypointFlag: string
	stopScanAtFolderNotes: boolean,
	showFolderNotes: boolean,
	debugLogging: boolean
}

const DEFAULT_SETTINGS: WaypointSettings = {
	waypointFlag: "%% Waypoint %%",
	stopScanAtFolderNotes: false,
	showFolderNotes: false,
	debugLogging: false
}

export default class Waypoint extends Plugin {
	static readonly BEGIN_WAYPOINT = "%% Begin Waypoint %%";
	static readonly END_WAYPOINT = "%% End Waypoint %%";

	foldersWithChanges = new Set<TFolder>();
	settings: WaypointSettings;

	async onload() {
		await this.loadSettings();
		this.app.workspace.onLayoutReady(async () => {
			// Register events after layout is built to avoid initial wave of 'create' events
			this.registerEvent(this.app.vault.on("create", (file) => {
				this.log("create " + file.name);
				this.foldersWithChanges.add(file.parent);
				this.scheduleUpdate();
			}));
			this.registerEvent(this.app.vault.on("delete", (file) => {
				this.log("delete " + file.name);
				const parentFolder = this.getParentFolder(file.path);
				if (parentFolder !== null) {
					this.foldersWithChanges.add(parentFolder);
					this.scheduleUpdate();
				}
			}));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
				this.log("rename " + file.name);
				this.foldersWithChanges.add(file.parent);
				const parentFolder = this.getParentFolder(oldPath);
				if (parentFolder !== null) {
					this.foldersWithChanges.add(parentFolder);
				}
				this.scheduleUpdate();
			}));
			this.registerEvent(this.app.vault.on("modify", this.detectWaypointFlag));
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WaypointSettingsTab(this.app, this));
	}

	onunload() {
	}

	/**
	 * Scan the given file for the waypoint flag. If found, update the waypoint.
	 * @param file The file to scan
	 */
	detectWaypointFlag = async (file: TFile) => {
		this.log("Modification on " + file.name);
		this.log("Scanning for Waypoint flags...");
		const text = await this.app.vault.cachedRead(file);
		const lines: string[] = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === this.settings.waypointFlag) {
				if (file.basename == file.parent.name) {
					this.log("Found waypoint flag in folder note!");
					await this.updateWaypoint(file);
					await this.updateParentWaypoint(file.parent, false);
					return;	
				} else if (file.parent.isRoot()) {
					this.log("Found waypoint flag in root folder.");
					this.printWaypointError(file, `%% Error: Cannot create a waypoint in the root folder of your vault. For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`);
					return;
				} else {
					this.log("Found waypoint flag in invalid note.");
					this.printWaypointError(file, `%% Error: Cannot create a waypoint in a note not named after the folder ("${file.basename}" is not the same as "${file.parent.name}"). For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`);
					return;
				}
			}
		}
		this.log("No waypoint flags found.");
	}

	async printWaypointError(file: TFile, error: string) {
		this.log("Creating waypoint error in " + file.path);
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		let waypointIndex = -1;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed === this.settings.waypointFlag) {
				waypointIndex = i;
			}
		}
		if (waypointIndex === -1) {
			console.error("Error: No waypoint flag found while trying to print error.");
			return;
		}
		lines.splice(waypointIndex, 1, error);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Given a file with a waypoint flag, generate a file tree representation and update the waypoint text.
	 * @param file The file to update
	 */
	async updateWaypoint(file: TFile) {
		this.log("Updating waypoint in " + file.path);
		const fileTree = await this.getFileTreeRepresentation(file.parent, 0, true);
		const waypoint = `${Waypoint.BEGIN_WAYPOINT}\n${fileTree}\n\n${Waypoint.END_WAYPOINT}`;
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		let waypointStart = -1;
		let waypointEnd = -1;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (waypointStart === -1 && (trimmed === this.settings.waypointFlag || trimmed === Waypoint.BEGIN_WAYPOINT)) {
				waypointStart = i;
			} else if (waypointStart !== -1 && trimmed === (Waypoint.END_WAYPOINT)) {
				waypointEnd = i;
				break;
			}
		}
		if (waypointStart === -1) {
			console.error("Error: No waypoint found while trying to update " + file.path);
			return;
		}
		this.log("Waypoint found at " + waypointStart + " to " + waypointEnd);
		lines.splice(waypointStart, waypointEnd !== -1 ? waypointEnd - waypointStart + 1 : 1, waypoint);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Generate a file tree representation of the given folder.
	 * @param node The node to generate the tree from
	 * @param indentLevel How many levels of indentation to draw
	 * @param topLevel Whether this is the top level of the tree or not
	 * @returns The string representation of the tree, or null if the node is not a file or folder
	 */
	async getFileTreeRepresentation(node: TAbstractFile, indentLevel: number, topLevel = false): Promise<string>|null {
		const bullet = "	".repeat(indentLevel) + "-";
		if (node instanceof TFile) {
			if (node.path.endsWith(".md")) {
				return `${bullet} [${node.basename}](${node.path})`;
			}
			return null;
		} else if (node instanceof TFolder) {
			let text = `${bullet} **${node.name}**`;
			const folderNote = this.app.vault.getAbstractFileByPath(node.path + "/" + node.name + ".md");
			if (folderNote instanceof TFile) {
				text = `${bullet} **[[${folderNote.basename}]]**`;
				if (!topLevel) {
					if (this.settings.stopScanAtFolderNotes) {
						return text;
					} else {
						const content = await this.app.vault.cachedRead(folderNote);
						if (content.includes(Waypoint.BEGIN_WAYPOINT) || content.includes(this.settings.waypointFlag)) {
							return text;
						}
					}
				}
			}
			if (node.children && node.children.length > 0) {
				let children = node.children;
				children = children.sort((a, b) => {
					return a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
				}).filter(child => this.settings.showFolderNotes || child.name !== node.name + ".md");
				if (children.length > 0) {
					text += "\n" + (await Promise.all(children.map(child => this.getFileTreeRepresentation(child, indentLevel + 1))))
					.filter(Boolean)
					.join("\n");
				}
				return text;
			} else {
				return `${bullet} **${node.name}**`;
			}

		}
		return null;
	}

	/**
	 * Scan the changed folders and their ancestors for waypoints and update them if found.
	 */
	updateChangedFolders = async () => {
		this.log("Updating changed folders...");
		this.foldersWithChanges.forEach((folder) => {
			this.log("Updating " + folder.path);
			this.updateParentWaypoint(folder, true);
		});
		this.foldersWithChanges.clear();
	}

	/**
	 * Schedule an update for the changed folders after debouncing to prevent excessive updates.
	 */
	scheduleUpdate = debounce(
		this.updateChangedFolders.bind(this),
		500,
		true
	);

	/**
	 * Update the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @param includeCurrentNode Whether to include the given folder in the search
	 */
	updateParentWaypoint = async (node: TAbstractFile, includeCurrentNode: boolean) => {
		const parentWaypoint = await this.locateParentWaypoint(node, includeCurrentNode);
		if (parentWaypoint !== null) {
			this.updateWaypoint(parentWaypoint);
		}
	}

	/**
	 * Locate the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @param includeCurrentNode Whether to include the given folder in the search
	 * @returns The ancestor waypoint, or null if none was found
	 */
	async locateParentWaypoint(node: TAbstractFile, includeCurrentNode: boolean): Promise<TFile> {
		this.log("Locating parent waypoint of " + node.name);
		let folder = includeCurrentNode ? node : node.parent;
		while (folder) {
			const folderNote = this.app.vault.getAbstractFileByPath(folder.path + "/" + folder.name + ".md");
			if (folderNote instanceof TFile) {
				this.log("Found folder note: " + folderNote.path);
				const text = await this.app.vault.cachedRead(folderNote);
				if (text.includes(Waypoint.BEGIN_WAYPOINT) || text.includes(this.settings.waypointFlag)) {
					this.log("Found parent waypoint!");
					return folderNote;
				}
			}
			folder = folder.parent;
		}
		this.log("No parent waypoint found.");
		return null;
	}

	/**
	 * Get the parent folder of the given filepath if it exists.
	 * @param path The filepath to search
	 * @returns The parent folder, or null if none exists
	 */
	getParentFolder(path: string): TFolder {
		const abstractFile = this.app.vault.getAbstractFileByPath(path.split("/").slice(0, -1).join("/"));
		if (abstractFile instanceof TFolder) {
			return abstractFile;
		} else {
			return null;
		}
	}

	log(message: string) {
		if (this.settings.debugLogging) {
			console.log(message);			
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class WaypointSettingsTab extends PluginSettingTab {
	plugin: Waypoint;

	constructor(app: App, plugin: Waypoint) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'Waypoint Settings'});
		new Setting(containerEl)
			.setName("Show Folder Notes")
			.setDesc("If enabled, folder notes will be listed alongside other notes in the generated waypoints.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showFolderNotes)
				.onChange(async (value) => {
					this.plugin.settings.showFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Stop Scan at Folder Notes")
			.setDesc("If enabled, the waypoint generator will stop scanning nested folders when it encounters a folder note. Otherwise, it will only stop if the folder note contains a waypoint.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.stopScanAtFolderNotes)
				.onChange(async (value) => {
					this.plugin.settings.stopScanAtFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Waypoint Flag")
			.setDesc("Text flag that triggers waypoint generation in a folder note. Must be surrounded by double-percent signs.")
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.waypointFlag)
				.setValue(this.plugin.settings.waypointFlag)
				.onChange(async (value) => {
					if (value && value.startsWith("%%") && value.endsWith("%%") && value !== "%%" && value !== "%%%" && value !== "%%%%") {
						this.plugin.settings.waypointFlag = value;
					} else {
						this.plugin.settings.waypointFlag = DEFAULT_SETTINGS.waypointFlag;
						console.error("Error: Waypoint flag must be surrounded by double-percent signs.");
					}
					await this.plugin.saveSettings();
				})
			);
		const postscriptElement = containerEl.createEl("div", {
			cls: "setting-item",
		});
		const descriptionElement = postscriptElement.createDiv({cls: "setting-item-description"});
		descriptionElement.createSpan({text: "For instructions on how to use this plugin, check out the README on "});
		descriptionElement.createEl("a", { attr: { "href": "https://github.com/IdreesInc/Waypoint" }, text: "GitHub" });
		descriptionElement.createSpan({text: " or get in touch with the author "});
		descriptionElement.createEl("a", { attr: { "href": "https://twitter.com/IdreesInc" }, text: "@IdreesInc" });
		postscriptElement.appendChild(descriptionElement);
	}
}
