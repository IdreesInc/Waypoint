import { App, debounce, normalizePath, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from "obsidian";

enum FolderNoteType {
	InsideFolder = "INSIDE_FOLDER",
	OutsideFolder = "OUTSIDE_FOLDER",
}

enum FlagType {
	Waypoint = "waypoint",
	Landmark = "landmark",
}

interface WaypointSettings {
	waypointFlag: string;
	landmarkFlag: string;
	stopScanAtFolderNotes: boolean;
	showFolderNotes: boolean;
	showNonMarkdownFiles: boolean;
	debugLogging: boolean;
	useWikiLinks: boolean;
	showEnclosingNote: boolean;
	folderNoteType: string;
	ignorePaths: string[];
}

const DEFAULT_SETTINGS: WaypointSettings = {
	waypointFlag: "Waypoint",
	landmarkFlag: "Landmark",
	stopScanAtFolderNotes: false,
	showFolderNotes: false,
	showNonMarkdownFiles: false,
	debugLogging: false,
	useWikiLinks: true,
	showEnclosingNote: false,
	folderNoteType: FolderNoteType.InsideFolder,
	ignorePaths: ["_attachments"],
};

export default class Waypoint extends Plugin {
	static readonly BEGIN_WAYPOINT = "%% Begin Waypoint %%";
	static readonly END_WAYPOINT = "%% End Waypoint %%";
	static readonly BEGIN_LANDMARK = "%% Begin Landmark %%";
	static readonly END_LANDMARK = "%% End Landmark %%";

	foldersWithChanges = new Set<TFolder>();
	settings: WaypointSettings;

	async onload() {
		await this.loadSettings();
		this.app.workspace.onLayoutReady(async () => {
			// Register events after layout is built to avoid initial wave of 'create' events
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					this.log("create " + file.name);
					this.foldersWithChanges.add(file.parent);
					this.scheduleUpdate();
				})
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					this.log("delete " + file.name);
					const parentFolder = this.getParentFolder(file.path);
					if (parentFolder !== null) {
						this.foldersWithChanges.add(parentFolder);
						this.scheduleUpdate();
					}
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					this.log("rename " + file.name);
					this.foldersWithChanges.add(file.parent);
					const parentFolder = this.getParentFolder(oldPath);
					if (parentFolder !== null) {
						this.foldersWithChanges.add(parentFolder);
					}
					this.scheduleUpdate();
				})
			);
			this.registerEvent(this.app.vault.on("modify", this.detectFlags));
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WaypointSettingsTab(this.app, this));
	}

	onunload() {}

	detectFlags = async (file: TFile) => {
		this.detectFlag(file, FlagType.Waypoint);
		this.detectFlag(file, FlagType.Landmark);
	};

	/**
	 * Scan the given file for the waypoint flag. If found, update the waypoint.
	 * @param file The file to scan
	 */
	detectFlag = async (file: TFile, flagType: FlagType) => {
		this.log("Modification on " + file.name);
		this.log("Scanning for " + flagType + " flags...");
		const postFlag = await this.setPostFlag(flagType);
		if (postFlag === null) {
			console.error("Error: Flag type not set, can not continue.");
			return;
		}
		const text = await this.app.vault.cachedRead(file);
		const lines: string[] = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === "%% " + postFlag + " %%") {
				if (this.isFolderNote(file)) {
					this.log("Found " + flagType + " flag in folder note!");
					await this.updatePoint(file, flagType);
					await this.updateParentPoint(file.parent, this.settings.folderNoteType === FolderNoteType.OutsideFolder);
					return;
				} else if (file.parent.isRoot()) {
					this.log("Found " + flagType + " flag in root folder.");
					this.printError(file, `%% Error: Cannot create a ` + flagType + ` in the root folder of your vault. For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`, flagType);
					return;
				} else {
					this.log("Found " + flagType + " flag in invalid note.");
					this.printError(file, `%% Error: Cannot create a ` + flagType + ` in a note that's not the folder note. For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`, flagType);
					return;
				}
			}
		}
		this.log("No " + flagType + " flags found.");
	};

	isFolderNote(file: TFile): boolean {
		if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
			return file.basename == file.parent.name;
		}
		if (file.parent) {
			return this.app.vault.getAbstractFileByPath(this.getCleanParentPath(file) + file.basename) instanceof TFolder;
		}
		return false;
	}

	getCleanParentPath(node: TAbstractFile): string {
		if (node.parent instanceof TFolder && node.parent.isRoot()) {
			return "";
		}
		return node.parent.path + "/";
	}

	async printError(file: TFile, error: string, flagType: FlagType) {
		this.log("Creating " + flagType + " error in " + file.path);
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		let waypointIndex = -1;
		const postFlag = await this.setPostFlag(flagType);
		if (postFlag === null) {
			console.error("Error: Flag type not set, can not continue.");
			return;
		}
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed === "%% " + postFlag + " %%") {
				waypointIndex = i;
			}
		}
		if (waypointIndex === -1) {
			console.error("Error: No " + flagType + " flag found while trying to print error.");
			return;
		}
		lines.splice(waypointIndex, 1, error);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	async setPoints(flag: string): Promise<[string, string] | [null, null]> {
		if (flag === FlagType.Waypoint) {
			return [Waypoint.BEGIN_WAYPOINT, Waypoint.END_WAYPOINT];
		}
		if (flag === FlagType.Landmark) {
			return [Waypoint.BEGIN_LANDMARK, Waypoint.END_LANDMARK];
		}
		return [null, null];
	}

	async setPostFlag(flag: FlagType): Promise<string> | null {
		if (flag === FlagType.Waypoint) {
			return this.settings.waypointFlag;
		} else if (flag === FlagType.Landmark) {
			return this.settings.landmarkFlag;
		}
		return null;
	}

	/**
	 * Given a file with a waypoint flag, generate a file tree representation and update the waypoint text.
	 * @param file The file to update
	 */
	async updatePoint(file: TFile, flagType: FlagType) {
		this.log("Updating " + flagType + " in " + file.path);
		let fileTree;
		if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
			fileTree = await this.getFileTreeRepresentation(file.parent, file.parent, 0, true);
		} else {
			const folder = this.app.vault.getAbstractFileByPath(this.getCleanParentPath(file) + file.basename);
			if (folder instanceof TFolder) {
				fileTree = await this.getFileTreeRepresentation(file.parent, folder, 0, true);
			}
		}
		const [beginPoint, endPoint] = await this.setPoints(flagType);
		const point = `${beginPoint}\n${fileTree}\n\n${endPoint}`;
		if (beginPoint === null || endPoint === null) {
			console.error('Error: No point type found from the tag "' + flagType + '"');
			return;
		}
		const postFlag = await this.setPostFlag(flagType);
		if (postFlag === null) {
			console.error("Error: Flag type not set, can not continue.");
			return;
		}
		const text = await this.app.vault.read(file);
		const lines: string[] = text.split("\n");
		let waypointStart = -1;
		let waypointEnd = -1;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (waypointStart === -1 && (trimmed === "%% " + postFlag + " %%" || trimmed === beginPoint)) {
				waypointStart = i;
				continue;
			}
			if (waypointStart !== -1 && trimmed === endPoint) {
				waypointEnd = i;
				break;
			}
		}
		if (waypointStart === -1) {
			console.error("Error: No " + flagType + " found while trying to update " + file.path);
			return;
		}
		this.log(flagType + " found at " + waypointStart + " to " + waypointEnd);
		lines.splice(waypointStart, waypointEnd !== -1 ? waypointEnd - waypointStart + 1 : 1, point);
		await this.app.vault.modify(file, lines.join("\n"));
	}

	/**
	 * Generate a file tree representation of the given folder.
	 * @param rootNode The root of the file tree that will be generated
	 * @param node The current node in our recursive descent
	 * @param indentLevel How many levels of indentation to draw
	 * @param topLevel Whether this is the top level of the tree or not
	 * @returns The string representation of the tree, or null if the node is not a file or folder
	 */
	async getFileTreeRepresentation(rootNode: TFolder, node: TAbstractFile, indentLevel: number, topLevel = false): Promise<string> | null {
		const bullet = "  ".repeat(indentLevel) + "-";
		if (!(node instanceof TFile) && !(node instanceof TFolder)) {
			return null;
		}
		this.log(node.path);
		if (this.ignorePath(node.path)) {
			return null;
		}
		if (node instanceof TFile) {
			if (this.settings.debugLogging) {
				console.log(node);
			}
			// Print the file name
			if (node.extension == "md") {
				if (this.settings.useWikiLinks) {
					return `${bullet} [[${node.basename}]]`;
				}
				return `${bullet} [${node.basename}](${this.getEncodedUri(rootNode, node)})`;
			}
			if (this.settings.showNonMarkdownFiles) {
				if (this.settings.useWikiLinks) {
					return `${bullet} [[${node.name}]]`;
				}
				return `${bullet} [${node.name}](${this.getEncodedUri(rootNode, node)})`;
			}
			return null;
		}
		let text = "";
		if (!topLevel || this.settings.showEnclosingNote) {
			// Print the folder name
			text = `${bullet} **${node.name}**`;
			let folderNote;
			if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
				folderNote = this.app.vault.getAbstractFileByPath(node.path + "/" + node.name + ".md");
			} else if (node.parent) {
				folderNote = this.app.vault.getAbstractFileByPath(node.parent.path + "/" + node.name + ".md");
			}
			if (folderNote instanceof TFile) {
				if (this.settings.useWikiLinks) {
					text = `${bullet} **[[${folderNote.basename}]]**`;
				}
				text = `${bullet} **[${folderNote.basename}](${this.getEncodedUri(rootNode, folderNote)})**`;
				if (!topLevel) {
					if (this.settings.stopScanAtFolderNotes) {
						return text;
					}
					const content = await this.app.vault.cachedRead(folderNote);
					if (content.includes(Waypoint.BEGIN_WAYPOINT) || content.includes("%% " + this.settings.waypointFlag + " %%")) {
						return text;
					}
				}
			}
		}
		if (!node.children || node.children.length == 0) {
			return `${bullet} **${node.name}**`;
		}
		// Print the files and nested folders within the folder
		let children = node.children;
		children = children.sort((a, b) => {
			return a.name.localeCompare(b.name, undefined, {
				numeric: true,
				sensitivity: "base",
			});
		});
		if (!this.settings.showFolderNotes) {
			if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
				children = children.filter((child) => (this.settings.showFolderNotes || child.name !== node.name + ".md") && !this.ignorePath(child.path));
			} else {
				const folderNames = new Set();
				for (const element of children) {
					if (element instanceof TFolder) {
						folderNames.add(element.name + ".md");
					}
				}
				children = children.filter((child) => (child instanceof TFolder || !folderNames.has(child.name)) && !this.ignorePath(child.path));
			}
		}
		if (children.length > 0) {
			const nextIndentLevel = topLevel && !this.settings.showEnclosingNote ? indentLevel : indentLevel + 1;
			text += (text === "" ? "" : "\n") + (await Promise.all(children.map((child) => this.getFileTreeRepresentation(rootNode, child, nextIndentLevel)))).filter(Boolean).join("\n");
		}
		return text;
	}

	/**
	 * Generate an encoded URI path to the given file that is relative to the given root.
	 * @param rootNode The from which the relative path will be generated
	 * @param node The node to which the path will be generated
	 * @returns The encoded path
	 */
	getEncodedUri(rootNode: TFolder, node: TAbstractFile) {
		if (rootNode.isRoot()) {
			return `./${encodeURI(node.path)}`;
		}
		return `./${encodeURI(node.path.substring(rootNode.path.length + 1))}`;
	}

	ignorePath(path: string): boolean {
		let found = false;
		this.settings.ignorePaths.forEach((comparePath) => {
			const regex = new RegExp(comparePath);
			if (path.match(regex)) {
				this.log(`Ignoring path: ${path}`);
				found = true;
			}
		});
		if (found) {
			return true;
		}
		return false;
	}

	/**
	 * Scan the changed folders and their ancestors for waypoints and update them if found.
	 */
	updateChangedFolders = async () => {
		this.log("Updating changed folders...");
		this.foldersWithChanges.forEach((folder) => {
			this.log("Updating " + folder.path);
			this.updateParentPoint(folder, true);
		});
		this.foldersWithChanges.clear();
	};

	/**
	 * Schedule an update for the changed folders after debouncing to prevent excessive updates.
	 */
	scheduleUpdate = debounce(this.updateChangedFolders.bind(this), 500, true);

	/**
	 * Update the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @param includeCurrentNode Whether to include the given folder in the search
	 */
	updateParentPoint = async (node: TAbstractFile, includeCurrentNode: boolean) => {
		const [parentFlag, parentPoint] = await this.locateParentPoint(node, includeCurrentNode);
		if (parentPoint === null) {
			return;
		}
		this.updatePoint(parentPoint, parentFlag);
		this.updateParentPoint(parentPoint.parent, false);
	};

	/**
	 * Locate the ancestor waypoint (if any) of the given file/folder.
	 * @param node The node to start the search from
	 * @param includeCurrentNode Whether to include the given folder in the search
	 * @returns The ancestor waypoint, or null if none was found
	 */
	async locateParentPoint(node: TAbstractFile, includeCurrentNode: boolean): Promise<[FlagType, TFile]> {
		this.log("Locating parent flag and file of " + node.name);
		let folder = includeCurrentNode ? node : node.parent;
		while (folder) {
			let folderNote;
			if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
				folderNote = this.app.vault.getAbstractFileByPath(folder.path + "/" + folder.name + ".md");
			} else {
				if (folder.parent) {
					folderNote = this.app.vault.getAbstractFileByPath(this.getCleanParentPath(folder) + folder.name + ".md");
				}
			}
			if (folderNote instanceof TFile) {
				this.log("Found folder note: " + folderNote.path);
				const text = await this.app.vault.cachedRead(folderNote);
				if (text.includes(Waypoint.BEGIN_WAYPOINT) || text.includes("%% " + this.settings.waypointFlag + " %%")) {
					this.log("Found parent waypoint!");
					return [FlagType.Waypoint, folderNote];
				}
				if (text.includes(Waypoint.BEGIN_LANDMARK) || text.includes("%% " + this.settings.landmarkFlag + " %%")) {
					this.log("Found parent landmark!");
					return [FlagType.Landmark, folderNote];
				}
			}
			folder = folder.parent;
		}
		this.log("No parent flag found.");
		return [null, null];
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
		}
		return null;
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
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Waypoint Settings" });
		new Setting(this.containerEl)
			.setName("Folder Note Style")
			.setDesc("Select the style of folder note used.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(FolderNoteType.InsideFolder, "Folder Name Inside")
					.addOption(FolderNoteType.OutsideFolder, "Folder Name Outside")
					.setValue(this.plugin.settings.folderNoteType)
					.onChange(async (value) => {
						this.plugin.settings.folderNoteType = value;
						await this.plugin.saveSettings();
					})
			);
		// new Setting(containerEl)
		// 	.setName("Debug Plugin")
		// 	.setDesc("If enabled, the plugin will create extensive logs.")
		// 	.addToggle((toggle) =>
		// 		toggle
		// 			.setValue(this.plugin.settings.debugLogging)
		// 			.onChange(async (value) => {
		// 				this.plugin.settings.debugLogging = value;
		// 				await this.plugin.saveSettings();
		// 			})
		// 	);
		new Setting(containerEl)
			.setName("Show Folder Notes")
			.setDesc("If enabled, folder notes will be listed alongside other notes in the generated waypoints.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showFolderNotes).onChange(async (value) => {
					this.plugin.settings.showFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Show Non-Markdown Files")
			.setDesc("If enabled, non-Markdown files will be listed alongside other notes in the generated waypoints.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showNonMarkdownFiles).onChange(async (value) => {
					this.plugin.settings.showNonMarkdownFiles = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Show Enclosing Note")
			.setDesc("If enabled, the name of the folder note containing the waypoint will be listed at the top of the generated waypoints.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showEnclosingNote).onChange(async (value) => {
					this.plugin.settings.showEnclosingNote = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Stop Scan at Folder Notes")
			.setDesc("If enabled, the waypoint generator will stop scanning nested folders when it encounters a folder note. Otherwise, it will only stop if the folder note contains a waypoint.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stopScanAtFolderNotes).onChange(async (value) => {
					this.plugin.settings.stopScanAtFolderNotes = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Use WikiLinks")
			.setDesc("If enabled, links will be generated like [[My Page]] instead of [My Page](../Folder/My%Page.md).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useWikiLinks).onChange(async (value) => {
					this.plugin.settings.useWikiLinks = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Waypoint Flag")
			.setDesc("Text flag that triggers waypoint generation in a folder note." + " To use in a note surround the flag with double-percent signs." + " For example, if you enter 'Waypoint' here, the flag in your note should be:" + " %% Waypoint %%")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.waypointFlag)
					.setValue(this.plugin.settings.waypointFlag)
					.onChange(async (value) => {
						if (value && value.indexOf("%%") < 0) {
							this.plugin.settings.waypointFlag = value;
						} else {
							this.plugin.settings.waypointFlag = DEFAULT_SETTINGS.waypointFlag;
							console.error("Error: Double percents will automatically be added, please do not include them in the flag.");
						}
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Landmark Flag")
			.setDesc("Text flag that triggers landmark generation in a folder note." + " To use in a note surround the flag with double-percent signs." + " For example, if you enter 'Landmark' here, the flag in your note should be:" + " %% Landmark %%")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.landmarkFlag)
					.setValue(this.plugin.settings.landmarkFlag)
					.onChange(async (value) => {
						if (value && value.indexOf("%%") < 0) {
							this.plugin.settings.landmarkFlag = value;
						} else {
							this.plugin.settings.landmarkFlag = DEFAULT_SETTINGS.landmarkFlag;
							console.error("Error: Double percents will automatically be added, please do not include them in the flag.");
						}
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Ignored Files/Folders")
			.setDesc("Regex ready list of files or folders to ignore while making" + " indexes. Please only enter one per line.")
			.addTextArea((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.ignorePaths.join("\n"))
					.setValue(this.plugin.settings.ignorePaths.join("\n"))
					.onChange(async (value) => {
						const paths = value
							.trim()
							.split("\n")
							.map((value) => this.getNormalizedPath(value));
						this.plugin.settings.ignorePaths = paths;
						await this.plugin.saveSettings();
					})
			);
		const postscriptElement = containerEl.createEl("div", {
			cls: "setting-item",
		});
		const descriptionElement = postscriptElement.createDiv({
			cls: "setting-item-description",
		});
		descriptionElement.createSpan({
			text: "For instructions on how to use this plugin, check out the README on ",
		});
		descriptionElement.createEl("a", {
			attr: { href: "https://github.com/IdreesInc/Waypoint" },
			text: "GitHub",
		});
		descriptionElement.createSpan({
			text: " or get in touch with the author ",
		});
		descriptionElement.createEl("a", {
			attr: { href: "https://twitter.com/IdreesInc" },
			text: "@IdreesInc",
		});
		postscriptElement.appendChild(descriptionElement);
	}

	getNormalizedPath(path: string): string {
		return path.length == 0 ? path : normalizePath(path);
	}
}
