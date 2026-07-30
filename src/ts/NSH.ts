import path from "path";
import { fork, ChildProcess } from 'child_process';

import { Window } from './Window';

export class NSH {
    window: Window;
    server: ChildProcess | null = null;
    
    constructor(window: Window) {
        this.window = window;
    }
    
    start() {
        this.server = fork(path.join(__dirname, "../../bin/nsh.js"));
        
        this.server.on("message", (msg) => {
            console.log("Message du serveur NSH :", msg);
        });

        this.server.on("error", (err) => {
            console.error("Erreur du serveur NSH :", err);
        });

        this.server.on("exit", (code) => {
            console.log(`Le serveur NSH s'est arrêté avec le code ${code}`);
            this.server = null;
        });
    }

    stop() {
        if (this.server) {
            this.server.kill();
            this.server = null;
            console.log("Serveur NSH arrêté.");
        }
    }
}