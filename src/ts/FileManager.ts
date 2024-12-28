import { dialog, OpenDialogOptions } from 'electron';
const fs = require('fs').promises;

export class FileManager {
    constructor() {}

    async selectFile(): Promise<string[] | undefined> {
        console.log('Selecting file...');

        const options: OpenDialogOptions = {
            properties: ['openFile'],
        };

        const result = await dialog.showOpenDialog(options);

        if (result.canceled) {
            console.log('User cancelled the file selection.');
            return undefined;
        }

        console.log('Selected file paths:', result.filePaths);
        return result.filePaths;
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

    async saveFile(content: string, path: string): Promise<void> {
        console.log('Saving file...');
        
        try {
            await fs.writeFile(path, content);
            console.log('File saved successfully:', path);
        } catch (error) {
            console.error('Error saving file:', error);
        }
    }
}
