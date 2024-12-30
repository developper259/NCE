import { dialog, OpenDialogOptions, SaveDialogOptions } from 'electron';
const fs = require('fs').promises;

export class FileManager {
    constructor() {}

    async selectFile(): Promise<string | undefined> {
        console.log('Selecting file...');

        const options: OpenDialogOptions = {
            properties: ['openFile'],
        };

        const result = await dialog.showOpenDialog(options);

        if (result.canceled) {
            console.log('User cancelled the file selection.');
            return undefined;
        }

        console.log('Selected file paths:', result.filePaths[0]);
        return result.filePaths[0];
    }

    async selectFiles(): Promise<string[] | undefined> {
        console.log('Selecting files...');

        const options: OpenDialogOptions = {
            properties: ['openFile', 'multiSelections'],
        };

        const result = await dialog.showOpenDialog(options);

        if (result.canceled) {
            console.log('User cancelled the files selection.');
            return undefined;
        }

        console.log('Selected file paths:', result.filePaths);
        return result.filePaths;
    }

    async selectNewFile(name: string): Promise<string | undefined> {
        console.log('Saving file...');

        const options: SaveDialogOptions = {
            title: 'Save File',
            defaultPath: name,
            buttonLabel: 'Save',
        };

        const result = await dialog.showSaveDialog(options);

        if (result.canceled) {
            console.log('User cancelled the save file dialog.');
            return undefined;
        }

        console.log('File path selected for saving:', result.filePath);
        return result.filePath || undefined;
    }

    async getFileContent(file: string[]): Promise<{} | undefined> {
        console.log('Getting file content...');

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
        console.log('Saving file...');
        
        try {
            await fs.writeFile(path, content);
            console.log('File saved successfully:', path);
        } catch (error) {
            console.error('Error saving file:', error);
        }
    }
}
