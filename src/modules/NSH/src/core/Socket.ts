import { WebSocketServer, WebSocket } from "ws";

import { Highlighter } from "./Highlighter";
import { languages } from "../languages/Languages";
import { DetectLanguageResponse, HighlightRequest, HighlightResponse, SupportedLanguageResponse } from "../types/socket";

export class NSHServer {
  private port: number;
  private wss: WebSocketServer | null = null;

  constructor(port: number = 8080) {
    this.port = port;
  }

  public start(): void {
    if (this.wss) {
      console.warn(
        `Le serveur NSH est déjà en cours d'exécution sur le port ${this.port}`,
      );
      return;
    }

    this.wss = new WebSocketServer({ port: this.port });
    console.log(`NSH Socket Server démarré sur ws://localhost:${this.port}`);

    this.wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
  }

  public stop(): void {
    if (this.wss) {
      this.wss.close(() => {
        console.log("NSH Socket Server arrêté.");
      });
      this.wss = null;
    }
  }

  private handleConnection(ws: WebSocket): void {
    console.log("Nouveau client connecté");
    ws.on("message", (message: string) => this.handleMessage(ws, message));
    ws.on("close", () => console.log("Client déconnecté"));
  }

  private handleMessage(ws: WebSocket, message: string): void {
    let request: HighlightRequest;

    try {
      request = JSON.parse(message.toString());

      if (!request.id) {
        ws.send(
          JSON.stringify({
            success: false,
            error: "Request not valid : id missing !",
          }),
        );
        return;
      }

      if (request.requestType === "highlight") {
        this.handleHighlight(ws, request);
      } else if (request.requestType === "highlightLine") {
        this.handleHighlightLine(ws, request);
      } else if (request.requestType === "supportedLanguages") {
        this.handleSupportedLanguage(ws, request);
      } else if (request.requestType === "detectLanguage") {
        this.handleDetectLanguage(ws, request);
      } else {
        ws.send(
          JSON.stringify({
            id: request.id,
            success: false,
            error: `requestType inconnu : ${request.requestType}`,
          }),
        );
      }
    } catch (e) {
      ws.send(
        JSON.stringify({ success: false, error: "Format JSON invalide" }),
      );
      return;
    }
  }

  private handleHighlight(ws: WebSocket, request: HighlightRequest): void {
    try {
      if (!request.language || request.code === undefined || request.code === null) {
        console.log(request);
        throw new Error('Request not valid : language or code missing !');
      }

      const language: string = request.language || "";
      const code: string = request.code;

      const languageDef = languages[language.toLowerCase()];

      if (!languageDef) {
        throw new Error(`Langage non supporté : ${language}`);
      }

      const highlighter = new Highlighter(languageDef, request.options);

      const responseType = request.responseType || "html";
      const response: HighlightResponse = {
        id: request.id,
        success: true,
      };

      if (responseType === "html") {
        response.html = highlighter.getHTML(code);
      }

      if (responseType === "tokens") {
        response.tokens = highlighter.getToken(code);

        if (request.options?.includeClasses) {
          response.tokens = highlighter.replaceByClasses(response.tokens);
        }
      }

      if (responseType === "both") {
        const result = highlighter.highlight(code);
        response.html = result.html;
        response.tokens = result.tokens;
        response.finalState = result.finalState;
      }

      ws.send(JSON.stringify(response));
    } catch (error: any) {
      const errorResponse: HighlightResponse = {
        id: request.id,
        success: false,
        error: error.message || "Erreur inconnue lors du highlight",
      };
      ws.send(JSON.stringify(errorResponse));
    }
  }

  private handleHighlightLine(ws: WebSocket, request: HighlightRequest): void {
    try {
      if (!request.language || request.code === undefined || request.code === null) {
        throw new Error('Request not valid : language or code missing !');
      }

      const language: string = request.language;
      const line: string = request.code;

      const languageDef = languages[language.toLowerCase()];

      if (!languageDef) {
        throw new Error(`Langage non supporté : ${language}`);
      }

      const highlighter = new Highlighter(languageDef, request.options);

      const initialState =
        request.initialState && request.initialState.length > 0
          ? request.initialState
          : ["root"];
      const lineIndex = request.lineIndex ?? 0;

      const responseType = request.responseType || "html";
      const response: HighlightResponse = {
        id: request.id,
        success: true,
      };

      if (responseType === "html") {
        const result = highlighter.getHTMLLine(line, initialState, lineIndex);
        response.html = result.html;
        response.finalState = result.finalState;
      } else if (responseType === "tokens") {
        const result = highlighter.getTokenLine(line, initialState, lineIndex);
        response.tokens = request.options?.includeClasses
          ? highlighter.replaceByClasses(result.tokens)
          : result.tokens;
        response.finalState = result.finalState;
      } else {
        const result = highlighter.highlightLine(line, initialState, lineIndex);
        response.html = result.html;
        response.tokens = result.tokens;
        response.finalState = result.finalState;
      }

      ws.send(JSON.stringify(response));
    } catch (error: any) {
      const errorResponse: HighlightResponse = {
        id: request.id,
        success: false,
        error: error.message || "Erreur inconnue lors du highlight de ligne",
      };
      ws.send(JSON.stringify(errorResponse));
    }
  }

  private handleSupportedLanguage(ws: WebSocket, request: HighlightRequest): void {
    try {
      const response: SupportedLanguageResponse = {
        id: request.id,
        success: true,
        languages: Highlighter.getSupportedLanguages(),
      };
      ws.send(JSON.stringify(response));
    } catch (error: any) {
      const errorResponse: SupportedLanguageResponse = {
        id: request.id,
        success: false,
        error: error.message || "Erreur inconnue lors de la récupération des langages supportés",
      };
      ws.send(JSON.stringify(errorResponse));
    }
  }

  private handleDetectLanguage(ws: WebSocket, request: HighlightRequest): void {
    try {
      if (!request.ext && !request.path && !request.fileName) {
        throw new Error('Request not valid : ext, path or fileName missing !');
      }

      let ext: string = request.ext || "";
      if (!ext) {
        const fileName = request.path ? request.path.split('/').pop() : request.fileName;

        if (fileName && fileName.includes('.')) {
          const parts = fileName.split('.');
          ext = `.${parts.pop()}`.toLowerCase();
        }
      }

      const language = Highlighter.detectLanguage(ext);

      const response: DetectLanguageResponse = {
        id: request.id,
        success: true,
        language: language,
      };
      ws.send(JSON.stringify(response));
    } catch (error: any) {
      const errorResponse: DetectLanguageResponse = {
        id: request.id,
        success: false,
        error: error.message || "Erreur inconnue lors de la détection du langage",
      };
      ws.send(JSON.stringify(errorResponse));
    }
  }
}