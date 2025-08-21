import * as vscode from "vscode";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

interface Change {
  offset: number;
  chars: number;
  insert: string;
}

interface ChangeSet {
  changes: Change[];
  timestamp: Date;
}

let statusItem: vscode.StatusBarItem;
let sessionActive = false;
let participantCount = 1;

let provider: WebsocketProvider | undefined;
let doc: Y.Doc | undefined;
let ytext: Y.Text | undefined;

let processingRemoteChanges = false;
const remoteChangeQueue: Change[][] = [];
const expectedChangeSets: ChangeSet[] = [];

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
      await vscode.env.clipboard.writeText(ytext?.toJSON() as string);
      vscode.window.showInformationMessage("PeerShare invite link copied!");
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (!sessionActive) {
        return;
      }

      const changes: Change[] = event.contentChanges.map((change) => ({
        offset: change.rangeOffset,
        chars: change.rangeLength,
        insert: change.text,
      }));

      const sortedChanges = [...changes].sort((a, b) => b.offset - a.offset);

      const expectedChangeIndex = expectedChangeSets.findIndex(
        (changeset) =>
          JSON.stringify(sortedChanges) === JSON.stringify(changeset.changes)
      );

      if (expectedChangeIndex !== -1) {
        // console.log("\n");
        // console.log(expectedChangeSets);
        // console.log(expectedChangeSets[expectedChangeIndex]);
        // console.log(sortedChanges);
        expectedChangeSets.splice(expectedChangeIndex, 1);
        return;
      }

      doc!.transact(() => {
        for (const change of sortedChanges) {
          ytext!.delete(change.offset, change.chars);
          ytext!.insert(change.offset, change.insert);
        }
      });
    })
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function processRemoteChanges() {
  const editor = vscode.window.activeTextEditor;

  if (processingRemoteChanges || !editor) return;

  processingRemoteChanges = true;

  try {
    while (remoteChangeQueue.length > 0) {
      const changes = remoteChangeQueue.shift()!;

      const workspaceEdit = new vscode.WorkspaceEdit();

      for (const change of changes) {
        const start = editor.document.positionAt(change.offset);
        const end = editor.document.positionAt(change.offset + change.chars);
        workspaceEdit.replace(
          editor.document.uri,
          new vscode.Range(start, end),
          change.insert
        );
      }

      expectedChangeSets.push({ changes, timestamp: new Date() });

      let success = false;
      let i = 0;

      while (!success) {
        success = await vscode.workspace.applyEdit(workspaceEdit);
        if (!success) {
          i += 1;
          console.log("retry", i);
        }
      }
    }
  } finally {
    processingRemoteChanges = false;
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

  ytext.observe(async (event) => {
    if (event.transaction?.local) return;

    const changes: Change[] = [];

    let index = 0;
    for (const delta of event.changes.delta) {
      if (delta.retain) {
        changes.push({ offset: delta.retain + index, chars: 0, insert: "" });

        index += delta.retain;
      } else if (changes.length === 0) {
        changes.push({ offset: 0, chars: 0, insert: "" });
      }

      if (delta.delete) {
        changes[changes.length - 1].chars = delta.delete;

        index += delta.delete;
      }
      if (delta.insert && typeof delta.insert === "string") {
        changes[changes.length - 1].insert = delta.insert;
      }
    }

    if (changes.length === 0) return;

    remoteChangeQueue.push(changes);

    processRemoteChanges();
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
      participantCount += added.length - removed.length;

      (async () => {
        // await sleep(30000);
        for (let i = 0; i < 100; i++) {
          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.insert(
            vscode.window.activeTextEditor?.document.uri!,
            vscode.window.activeTextEditor?.document.lineAt(0).range.end!,
            "a"
          );
          let success = false;
          while (!success) {
            success = await vscode.workspace.applyEdit(workspaceEdit);
          }
          await sleep(250);
        }
      })();

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
  participantCount = 1;

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
