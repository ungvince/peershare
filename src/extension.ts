import * as vscode from "vscode";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { buffer } from "stream/consumers";

let statusItem: vscode.StatusBarItem;
let sessionActive = false;
let participantCount = 0;
let uploading = false;

let provider: WebsocketProvider | undefined;
let doc: Y.Doc | undefined;
let ytext: Y.Text | undefined;

let watcher: vscode.FileSystemWatcher | undefined;

interface BaseRemoteChange {
  offset: number;
}

interface RemoteInsert extends BaseRemoteChange {
  type: "insert";
  text: string;
}

interface RemoteDelete extends BaseRemoteChange {
  type: "delete";
  chars: number;
}

type RemoteChange = RemoteInsert | RemoteDelete;

let contentChangesBuffer: vscode.TextDocumentContentChangeEvent[] = [];
const remoteChangeQueue: any[] = [];
let isApplyingRemoteChange = false;
const remoteChanges: RemoteChange[] = [];

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10_000
  );
  statusItem.name = "PeerShare";
  statusItem.command = "peershare.startOrStop";
  updateStatusItem();
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("peershare.startOrStop", async () => {
      if (!sessionActive) {
        await startSession();
      } else {
        await stopSession();
      }
    }),
    vscode.commands.registerCommand("peershare.invite", async () => {
      const link = await createInviteLink();
      console.log(contentChangesBuffer);
      await vscode.env.clipboard.writeText(ytext?.toJSON() as string);
      vscode.window.showInformationMessage("PeerShare invite link copied!");
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (!sessionActive) {
        return;
      }

      const sortedChanges = [...event.contentChanges].sort(
        (a, b) => b.rangeOffset - a.rangeOffset
      );

      doc!.transact(() => {
        let isRemoteChange = false;

        for (const change of sortedChanges) {
          if (isApplyingRemoteChange) {
            let deletion: RemoteDelete = {
              type: "delete",
              offset: change.rangeOffset,
              chars: change.rangeLength,
            };

            let insertion: RemoteInsert = {
              type: "insert",
              offset: change.rangeOffset,
              text: change.text,
            };
            for (const remoteChange of remoteChanges) {
              if (remoteChange.type === "delete") {
                if (
                  remoteChange.offset === deletion.offset &&
                  remoteChange.chars === deletion.chars
                ) {
                  isRemoteChange = true;
                  remoteChanges.splice(remoteChanges.indexOf(remoteChange), 1);
                  break;
                }
              } else if (remoteChange.type === "insert") {
                if (
                  remoteChange.offset === insertion.offset &&
                  remoteChange.text === insertion.text
                ) {
                  isRemoteChange = true;
                  remoteChanges.splice(remoteChanges.indexOf(remoteChange), 1);
                  break;
                }
              }
            }
          }
          if (!isApplyingRemoteChange || !isRemoteChange)
            ytext!.delete(change.rangeOffset, change.rangeLength);
          if (!isApplyingRemoteChange || !isRemoteChange)
            ytext!.insert(change.rangeOffset, change.text);
        }
      });
    })
  );
}

async function processRemoteChangeQueue() {
  if (isApplyingRemoteChange || remoteChangeQueue.length === 0) {
    return;
  }

  isApplyingRemoteChange = true;

  const deltas = remoteChangeQueue.shift()!;
  const editor = vscode.window.activeTextEditor;

  if (!editor) return;

  const workspaceEdit = new vscode.WorkspaceEdit();
  let cursor = 0;

  for (const delta of deltas) {
    if (delta.retain) {
      cursor += delta.retain;
    }
    if (delta.delete) {
      const start = editor.document.positionAt(cursor);
      const end = editor.document.positionAt(cursor + delta.delete);
      remoteChanges.push({
        type: "delete",
        offset: cursor,
        chars: delta.delete,
      });
      workspaceEdit.delete(editor.document.uri, new vscode.Range(start, end));
    }
    if (delta.insert && typeof delta.insert === "string") {
      const pos = editor.document.positionAt(cursor);
      remoteChanges.push({
        type: "insert",
        offset: cursor,
        text: delta.insert,
      });
      workspaceEdit.insert(editor.document.uri, pos, delta.insert);
    }
  }

  await vscode.workspace.applyEdit(workspaceEdit);

  isApplyingRemoteChange = false;

  if (remoteChangeQueue.length > 0) {
    processRemoteChangeQueue();
  }
}

async function startSession() {
  const room = await vscode.window.showInputBox({
    prompt: "Enter PeerShare room name",
    value: "vscode-peershare-room",
    ignoreFocusOut: true,
  });
  if (!room) return;

  doc = new Y.Doc();
  ytext = doc.getText("shared-text");

  ytext.observe(async (event, transaction) => {
    if (event.transaction?.local) return;

    remoteChangeQueue.push(event.changes.delta);
    processRemoteChangeQueue();
  });

  provider = new WebsocketProvider("ws://localhost:1234", room, doc);

  provider.on("status", (e: any) => {
    console.log("[ws] status:", e.status);
    vscode.window.setStatusBarMessage(`PeerShare WS: ${e.status}`, 2000);
  });

  provider.on("sync", (synced: boolean) => {
    console.log("[ws] synced:", synced);
  });

  provider.on("connection-error", (e: any) => {
    console.error("[ws] connection-error:", e?.message ?? e);
    vscode.window.showWarningMessage("PeerShare: WebSocket connection error.");
  });

  provider.on("connection-close", (ev: any) => {
    console.warn("[ws] connection-close:", ev?.code, ev?.reason);
  });

  let awareness = provider.awareness;
  participantCount = awareness.getStates().size;

  awareness.on(
    "change",
    ({
      added,
      updated,
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      console.log("Awareness changed:", { added, updated, removed });
      updateStatusItem();
    }
  );

  sessionActive = true;
  await vscode.commands.executeCommand(
    "setContext",
    "peershare.sessionActive",
    true
  );

  updateStatusItem();
}

async function stopSession() {
  sessionActive = false;
  await vscode.commands.executeCommand(
    "setContext",
    "peershare.sessionActive",
    false
  );
  provider?.destroy();
  doc?.destroy();

  provider = undefined;
  doc = undefined;
  ytext = undefined;
  participantCount = 0;

  updateStatusItem();
}

function updateStatusItem() {
  if (sessionActive) {
    statusItem.text = `$(broadcast) PeerShare: ${participantCount}`;
    statusItem.tooltip = "PeerShare session active — click to stop";
  } else {
    statusItem.text = `$(broadcast) Start PeerShare`;
    statusItem.tooltip = "Start a PeerShare session";
  }
}

async function createInviteLink(): Promise<string> {
  return "peershare://join?room=vscode-peershare-room";
}

export function deactivate() {
  stopSession();
  statusItem?.dispose();
}
