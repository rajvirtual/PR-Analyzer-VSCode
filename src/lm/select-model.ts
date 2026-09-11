import * as vscode from "vscode";
import { chooseModel } from "./model-preference.js";
import { rememberedChatModel } from "./model-memory.js";

/**
 * Order of authority: an explicit setting, then whatever the reader last used in
 * `@pr` chat, then whatever Copilot offers first.
 */
export async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const configured = vscode.workspace.getConfiguration("prAnalyzer").get<string>("model", "");
  const preferred = configured.trim() || rememberedChatModel()?.id || "";
  return chooseModel(models, preferred);
}

export async function pickModel(): Promise<string | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (models.length === 0) {
    void vscode.window.showWarningMessage("No Copilot model is available.");
    return undefined;
  }

  const current = vscode.workspace.getConfiguration("prAnalyzer").get<string>("model", "");
  const items: (vscode.QuickPickItem & { value: string })[] = [
    {
      label: "Follow the chat picker",
      description: rememberedChatModel()?.name
        ? `currently ${rememberedChatModel()?.name}`
        : "whichever model Copilot offers first, until @pr is used",
      value: "",
    },
    ...models.map((model) => ({
      label: model.name,
      description: model.id === current ? "selected" : model.family,
      value: model.id,
    })),
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: "Model for ordering and the diagram",
    placeHolder: "The @pr chat always uses the model in the chat picker",
  });
  if (!choice) return undefined;

  await vscode.workspace
    .getConfiguration("prAnalyzer")
    .update("model", choice.value, vscode.ConfigurationTarget.Global);
  return choice.value;
}
