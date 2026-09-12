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
    title: "Model for the diagram, read-through and Explain",
    placeHolder: "The @pr chat always uses the model in the chat picker",
  });
  if (!choice) return undefined;

  await vscode.workspace
    .getConfiguration("prAnalyzer")
    .update("model", choice.value, vscode.ConfigurationTarget.Global);
  return choice.value;
}

/** Finds a model by id, family, or part of its name, without falling back to the first. */
function findModel(
  models: vscode.LanguageModelChat[],
  preferred: string,
): vscode.LanguageModelChat | undefined {
  const needle = preferred.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    models.find((model) => [model.id, model.family, model.name].some((v) => v.toLowerCase() === needle)) ??
    models.find((model) => `${model.id} ${model.family} ${model.name}`.toLowerCase().includes(needle))
  );
}

/**
 * The model for ordering and the diagram: the main model unless a faster one is set.
 *
 * Empty keeps the diagram at the main model's quality; setting it trades accuracy for speed.
 */
export async function selectStructureModel(): Promise<vscode.LanguageModelChat | undefined> {
  const configured = vscode.workspace.getConfiguration("prAnalyzer").get<string>("structureModel", "");
  if (!configured.trim()) return selectModel();
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  return findModel(models, configured) ?? selectModel();
}

export async function pickStructureModel(): Promise<string | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (models.length === 0) {
    void vscode.window.showWarningMessage("No Copilot model is available.");
    return undefined;
  }

  const current = vscode.workspace.getConfiguration("prAnalyzer").get<string>("structureModel", "");
  const items: (vscode.QuickPickItem & { value: string })[] = [
    {
      label: "Same as the main model",
      description: "ordering and the diagram follow prAnalyzer.model",
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
    placeHolder: "A fast model keeps these structural steps quick",
  });
  if (!choice) return undefined;

  await vscode.workspace
    .getConfiguration("prAnalyzer")
    .update("structureModel", choice.value, vscode.ConfigurationTarget.Global);
  return choice.value;
}
