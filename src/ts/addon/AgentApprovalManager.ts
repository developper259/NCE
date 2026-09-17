import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { ipcMain } from "electron";
import type { Window } from "../Window";

export type AgentApprovalDecision = "once" | "workspace" | "cancel";

export interface AgentApprovalPreview {
  type: "command" | "text" | "path" | "action";
  value: string;
}

export interface AgentApprovalRequest {
  permissionType: string;
  workspaceRoot: string;
  requestId?: string;
  runId?: number | null;
  sessionId?: string | null;
  title: string;
  message: string;
  preview?: AgentApprovalPreview | null;
  allowWorkspaceGrant?: boolean;
  timeoutMs?: number;
}

export interface AgentApprovalResult {
  approvalId: string;
  decision: AgentApprovalDecision;
  source: "user" | "workspace" | "cancelled";
}

interface PendingApproval {
  approvalId: string;
  permissionType: string;
  workspaceRoot: string;
  requestId?: string;
  runId?: number | null;
  sessionId?: string | null;
  allowWorkspaceGrant: boolean;
  resolve: (result: AgentApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DECISIONS = new Set<AgentApprovalDecision>([
  "once",
  "workspace",
  "cancel",
]);

export class AgentApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly workspaceGrants = new Map<string, Set<string>>();
  private ipcRegistered = false;

  constructor(private readonly window: Window) {}

  handleIPC() {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    ipcMain.handle("Agent:respondApproval", async (event, payload: unknown) =>
      this.respond(event.sender, payload),
    );
    ipcMain.handle(
      "Agent:cancelApproval",
      async (_event, approvalId: unknown) =>
        typeof approvalId === "string" && this.cancelApproval(approvalId),
    );
  }

  async request(input: AgentApprovalRequest): Promise<AgentApprovalResult> {
    const approvalId = randomUUID();
    if (!this.isValidRequest(input)) {
      return this.cancelled(approvalId);
    }

    const workspaceRoot = await this.canonicalRoot(input.workspaceRoot);
    if (this.hasWorkspaceGrant(workspaceRoot, input.permissionType)) {
      return {
        approvalId,
        decision: "workspace",
        source: "workspace",
      };
    }

    const browserWindow = this.window.window;
    if (!browserWindow || browserWindow.isDestroyed()) {
      return this.cancelled(approvalId);
    }

    const payload = {
      approvalId,
      permissionType: input.permissionType,
      workspaceRoot,
      requestId: input.requestId || null,
      runId: input.runId ?? null,
      sessionId: input.sessionId || null,
      title: input.title,
      message: input.message,
      preview: input.preview || null,
      allowWorkspaceGrant: input.allowWorkspaceGrant === true,
    };
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Math.floor(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    );

    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.cancelApproval(approvalId),
        timeoutMs,
      );
      this.pending.set(approvalId, {
        approvalId,
        permissionType: input.permissionType,
        workspaceRoot,
        requestId: input.requestId,
        runId: input.runId,
        sessionId: input.sessionId,
        allowWorkspaceGrant: input.allowWorkspaceGrant === true,
        resolve,
        timer,
      });
      try {
        browserWindow.webContents.send("Agent:approvalRequested", payload);
      } catch {
        this.cancelApproval(approvalId);
      }
    });
  }

  cancelApproval(approvalId: string): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.pending.delete(approvalId);
    clearTimeout(pending.timer);
    pending.resolve(this.cancelled(approvalId));
    return true;
  }

  cancelByRequestId(requestId: string): boolean {
    return this.cancelMatching((pending) => pending.requestId === requestId);
  }

  cancelByRunId(runId: number): number {
    return this.cancelAllMatching((pending) => pending.runId === runId);
  }

  cancelBySessionId(sessionId: string): number {
    return this.cancelAllMatching((pending) => pending.sessionId === sessionId);
  }

  cancelAll(): number {
    return this.cancelAllMatching(() => true);
  }

  hasWorkspaceGrant(workspaceRoot: string, permissionType: string): boolean {
    return (
      this.workspaceGrants.get(workspaceRoot)?.has(permissionType) === true
    );
  }

  private respond(sender: Electron.WebContents, payload: unknown) {
    if (!payload || typeof payload !== "object") {
      return { accepted: false, code: "INVALID_REQUEST" };
    }
    if (sender !== this.window.window?.webContents) {
      return { accepted: false, code: "UNAUTHORIZED_SENDER" };
    }
    const input = payload as { approvalId?: unknown; decision?: unknown };
    if (
      typeof input.approvalId !== "string" ||
      typeof input.decision !== "string" ||
      !DECISIONS.has(input.decision as AgentApprovalDecision)
    ) {
      return { accepted: false, code: "INVALID_DECISION" };
    }
    const pending = this.pending.get(input.approvalId);
    if (!pending) return { accepted: false, code: "APPROVAL_NOT_FOUND" };

    const decision = input.decision as AgentApprovalDecision;
    if (decision === "workspace" && !pending.allowWorkspaceGrant) {
      this.cancelApproval(pending.approvalId);
      return { accepted: false, code: "WORKSPACE_GRANT_NOT_ALLOWED" };
    }

    this.pending.delete(pending.approvalId);
    clearTimeout(pending.timer);
    if (decision === "workspace") {
      const grants =
        this.workspaceGrants.get(pending.workspaceRoot) || new Set<string>();
      grants.add(pending.permissionType);
      this.workspaceGrants.set(pending.workspaceRoot, grants);
    }
    pending.resolve({
      approvalId: pending.approvalId,
      decision,
      source: "user",
    });
    return { accepted: true, approvalId: pending.approvalId, decision };
  }

  private isValidRequest(input: AgentApprovalRequest): boolean {
    return Boolean(
      input &&
      typeof input.permissionType === "string" &&
      input.permissionType.trim() &&
      typeof input.workspaceRoot === "string" &&
      input.workspaceRoot.trim() &&
      typeof input.title === "string" &&
      input.title.trim() &&
      typeof input.message === "string" &&
      input.message.trim(),
    );
  }

  private async canonicalRoot(root: string): Promise<string> {
    try {
      return await fs.realpath(root);
    } catch {
      return path.resolve(root);
    }
  }

  private cancelled(approvalId: string): AgentApprovalResult {
    return { approvalId, decision: "cancel", source: "cancelled" };
  }

  private cancelMatching(predicate: (pending: PendingApproval) => boolean) {
    for (const pending of this.pending.values()) {
      if (predicate(pending)) return this.cancelApproval(pending.approvalId);
    }
    return false;
  }

  private cancelAllMatching(
    predicate: (pending: PendingApproval) => boolean,
  ): number {
    let count = 0;
    for (const pending of [...this.pending.values()]) {
      if (predicate(pending) && this.cancelApproval(pending.approvalId))
        count++;
    }
    return count;
  }
}
