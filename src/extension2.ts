// src/extension.ts
import * as vscode from "vscode";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

let statusItem: vscode.StatusBarItem;
let sessionActive = false;
let participantCount = 1;
let provider: WebsocketProvider | undefined;
let doc: Y.Doc | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10_000
  );
  statusItem.name = "PeerShare";
  statusItem.command = "peershare.startOrStop";
  updateStatusItem();
  statusItem.show();

  vscode.workspace.onDidChangeTextDocument(
    (event: vscode.TextDocumentChangeEvent) => {
      if (sessionActive && doc) {
        console.log(event.document.getText());
      }
    }
  );

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("peershare.startOrStop", async () => {
      if (!sessionActive) {
        await startSession();
      } else {
        await stopSession();
      }
      updateStatusItem();
    }),
    vscode.commands.registerCommand("peershare.invite", async () => {
      const link = await createInviteLink();
      await vscode.env.clipboard.writeText(link);
      vscode.window.showInformationMessage("PeerShare invite link copied!");
    })
  );
}

async function startSession() {
  sessionActive = true;
  participantCount = 1;

  createDoc();

  provider = new WebsocketProvider("ws://localhost:1234", "nigger", doc!);

  vscode.commands.executeCommand("setContext", "peershare.sessionActive", true);
}

async function stopSession() {
  sessionActive = false;
  participantCount = 0;
  // TODO: tear down PeerShare session
  vscode.commands.executeCommand(
    "setContext",
    "peershare.sessionActive",
    false
  );

  doc!.destroy();
  provider!.destroy();

  doc = undefined;
  provider = undefined;
}

function updateStatusItem() {
  if (sessionActive) {
    statusItem.text = `$(broadcast) PeerShare: ${participantCount}`;
    statusItem.tooltip = "PeerShare session active — click to stop";
    statusItem.command = "peershare.startOrStop";
  } else {
    statusItem.text = `$(broadcast) Start PeerShare`;
    statusItem.tooltip = "Start a PeerShare session";
    statusItem.command = "peershare.startOrStop";
  }
}

async function createInviteLink(): Promise<string> {
  // Replace with your actual signaling/bootstrapping
  return "peershare://join?code=ABC123";
}

export function deactivate() {
  statusItem?.dispose();
}

function createDoc() {
  doc = new Y.Doc();
}
