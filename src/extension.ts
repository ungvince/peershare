import * as vscode from "vscode";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { buffer } from "stream/consumers";

let statusItem: vscode.StatusBarItem;
let sessionActive = false;
let participantCount = 0;
let syncing = false;

let provider: WebsocketProvider | undefined;
let doc: Y.Doc | undefined;
let ytext: Y.Text | undefined;

let watcher: vscode.FileSystemWatcher | undefined;

let contentChangesBuffer: vscode.TextDocumentContentChangeEvent[] = [];
let bufferInterval: NodeJS.Timeout | undefined;

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
      await vscode.env.clipboard.writeText(link);
      vscode.window.showInformationMessage("PeerShare invite link copied!");
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (syncing) return;

      for (const change of event.contentChanges) {
        contentChangesBuffer.push(change);
      }

      vscode.workspace.fs.writeFile(
        vscode.Uri.file("/home/vince/test/test.txt"),
        new TextEncoder().encode(ytext!.toJSON())
      );
    })
  );
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
  bufferInterval = setInterval(() => {
    if (!ytext) return;

    const deltas = [];

    doc!.transact(() => {
      while (contentChangesBuffer.length > 0) {
        const change = contentChangesBuffer.shift()!;
  
        const offset = change.rangeOffset;
        const deletion = change.rangeLength;
        const insertion = change.text;
        ytext.delete(offset, deletion);
        ytext.insert(offset, insertion);
      }
    })
  }, 100);

  ytext.observe(async (event, transaction) => {
    let cursor = 0;

    if (event.transaction?.origin === "vscode-local" || event.transaction?.local) return;
    syncing = true;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const firstLine = editor.document.lineAt(0);
    const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
    const fullRange = new vscode.Range(
      firstLine.range.start,
      lastLine.range.end
    );

    await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, event.target.toJSON());
    });
    syncing = false;
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
  bufferInterval && clearInterval(bufferInterval);
  provider?.destroy();
  doc?.destroy();

  provider = undefined;
  doc = undefined;
  ytext = undefined;
  participantCount = 0;
  bufferInterval = undefined;

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
