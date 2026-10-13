import { App, PluginSettingTab, Setting } from 'obsidian';
import SemanticPlugin from './main';

export interface SemanticSettings {
	endpointUrl: string;
	apiKey: string;
	model: string;
	includeFolders: string[];
	excludeFolders: string[];
	excludePatterns: string[];
	maxResults: number;
	minSimilarity: number;
	chunkMaxChars: number;
	chunkOverlapChars: number;
	debounceMs: number;
}

export const DEFAULT_SETTINGS: SemanticSettings = {
	endpointUrl: '',
	apiKey: '',
	model: 'text-embedding-3-small',
	includeFolders: [''],
	excludeFolders: [],
	excludePatterns: [],
	maxResults: 10,
	minSimilarity: 0.8,
	chunkMaxChars: 1500,
	chunkOverlapChars: 150,
	debounceMs: 800,
};

export class SemanticSettingTab extends PluginSettingTab {
	plugin: SemanticPlugin;

	constructor(app: App, plugin: SemanticPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Embedding endpoint URL')
			.setDesc('OpenAI-compatible embeddings base URL')
			.addText(text => {
				text.setValue(this.plugin.settings.endpointUrl);
				text.onChange(async v => {
					this.plugin.settings.endpointUrl = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Bearer token for embeddings endpoint')
			.addText(text => {
				text.setValue(this.plugin.settings.apiKey);
				text.onChange(async v => {
					this.plugin.settings.apiKey = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Embedding model name')
			.addText(text => {
				text.setValue(this.plugin.settings.model);
				text.onChange(async v => {
					this.plugin.settings.model = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Include folders')
			.setDesc('Comma-separated folder paths to index. Empty = whole vault')
			.addTextArea(text => {
				text.setValue(this.plugin.settings.includeFolders.join(', '));
				text.onChange(async v => {
					this.plugin.settings.includeFolders = v.split(',').map(s=>s.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Exclude folders')
			.setDesc('Comma-separated folder paths to skip')
			.addTextArea(text => {
				text.setValue(this.plugin.settings.excludeFolders.join(', '));
				text.onChange(async v => {
					this.plugin.settings.excludeFolders = v.split(',').map(s=>s.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default max results')
			.setDesc('Default number of results')
			.addSlider(slider => {
				slider.setLimits(1, 100, 1);
				slider.setValue(this.plugin.settings.maxResults);
				slider.setDynamicTooltip();
				slider.onChange(async v => {
					this.plugin.settings.maxResults = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default min similarity')
			.setDesc('Cosine similarity threshold')
			.addSlider(slider => {
				slider.setLimits(0, 1, 0.01);
				slider.setValue(this.plugin.settings.minSimilarity);
				slider.setDynamicTooltip();
				slider.onChange(async v => {
					this.plugin.settings.minSimilarity = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Chunk max chars')
			.setDesc('Maximum characters per chunk')
			.addSlider(slider => {
				slider.setLimits(200, 4000, 50);
				slider.setValue(this.plugin.settings.chunkMaxChars);
				slider.setDynamicTooltip();
				slider.onChange(async v => {
					this.plugin.settings.chunkMaxChars = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Chunk overlap chars')
			.setDesc('Overlap between chunks')
			.addSlider(slider => {
				slider.setLimits(0, 500, 10);
				slider.setValue(this.plugin.settings.chunkOverlapChars);
				slider.setDynamicTooltip();
				slider.onChange(async v => {
					this.plugin.settings.chunkOverlapChars = v;
					await this.plugin.saveSettings();
				});
			});
	}
}
