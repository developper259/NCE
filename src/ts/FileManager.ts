import { dialog, BrowserWindow } from 'electron';
const fs = require('fs').promises;
const path = require('path');

export type UnsavedCloseChoice = 'save' | 'dontSave' | 'cancel';

export interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'folder';
}

export class FileManager {
    window: InstanceType<typeof BrowserWindow>;

    constructor(window: BrowserWindow) {
        this.window = window;
    }

    async selectFile(): Promise<string | undefined> {
        const result = await dialog.showOpenDialog(this.window, {
            properties: ['openFile'],
        });
        if (result.canceled) {
            console.log('User cancelled the file selection.');
            return undefined;
        }

        console.log('Selected file paths:', result.filePaths[0]);
        return result.filePaths[0];
    }

    async selectFiles(): Promise<string[] | undefined> {
        const result = await dialog.showOpenDialog(this.window, {
            properties: ['openFile', 'multiSelections'],
        });

        if (result.canceled) {
            console.log('User cancelled the files selection.');
            return undefined;
        }

        console.log('Selected file paths:', result.filePaths);
        return result.filePaths;
    }

    async selectNewFile(name: string): Promise<string | undefined> {
        const result = await dialog.showSaveDialog(this.window, {
            title: 'Save File',
            defaultPath: name,
            buttonLabel: 'Save',
        });

        if (result.canceled) {
            console.log('User cancelled the save file dialog.');
            return undefined;
        }

        console.log('File path selected for saving:', result.filePath);
        return result.filePath || undefined;
    }

    async getFileContent(file: string[]): Promise<{} | undefined> {
        if (!file) {
            console.log('No file selected.');
            return Promise.resolve(undefined);
        }
        const fileContents: { [key: string]: string } = {};

        for (const filePath of file) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                fileContents[filePath] = content;
            } catch (error) {
                console.error(`Error reading file ${filePath}:`, error);
            }
        }

        return fileContents;
    }

    async saveFile(path: string, content: string): Promise<void> {
        try {
            await fs.writeFile(path, content);
            console.log('File saved successfully:', path);
        } catch (error) {
            console.error('Error saving file:', error);
        }
    }

    async confirmUnsavedChanges(
        fileName: string): Promise<UnsavedCloseChoice> {
        const { response } = await dialog.showMessageBox(this.window, {
            type: 'warning',
            buttons: ['Save', "Don't Save", 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            message: `Do you want to save the changes you made to "${fileName}"?`,
            detail: 'Your changes will be lost if you don\'t save them.',
        });

        if (response === 0) return 'save';
        if (response === 1) return 'dontSave';
        return 'cancel';
    }

    async getFolderContent(dirPath: string): Promise<FileItem[]> {
        if (!dirPath) return [];
        try {
            const entries = await fs.readdir(dirPath);

            const items = await Promise.all(
                entries.map(async (entry: string): Promise<FileItem> => {
                    const fullPath = path.join(dirPath, entry);
                    const stats = await fs.stat(fullPath);
                    return {
                        name: entry,
                        path: fullPath,
                        type: stats.isDirectory() ? 'folder' : 'file'
                    };
                })
            );

            return items.sort((a, b) => {
                if (a.type === b.type) {
                    return a.name.localeCompare(b.name);
                }
                return a.type === 'folder' ? -1 : 1;
            });

        } catch (error) {
            console.error("Erreur lors de la lecture du dossier :", error);
            return [];
        }
    }

    async selectFolder(): Promise<string | undefined> {
        const { canceled, filePaths } = await dialog.showOpenDialog(this.window, {
            properties: ['openDirectory']
        });

        if (canceled || filePaths.length === 0) {
            return undefined;
        }

        return filePaths[0];
    }
}
