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
    title: "Model for the read-through and Explain",
    placeHolder: "The @pr chat always uses the model in the chat picker",
  });
  if (!choice) return undefined;

  await vscode.workspace
    .getConfiguration("prAnalyzer")
    .update("model", choice.value, vscode.ConfigurationTarget.Global);
  return choice.value;
}

const FAST_HINTS = ["mini", "nano", "small", "lite", "flash", "haiku", "fast", "turbo"];

/** A model whose name marks it as a small or fast variant, whatever the vendor. */
function looksFast(model: vscode.LanguageModelChat): boolean {
  const haystack = `${model.id} ${model.family} ${model.name}`.toLowerCase();
  return FAST_HINTS.some((hint) => haystack.includes(hint));
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
 * The model for ordering and the diagram: structural work a fast model does well.
 *
 * With no setting, the fastest-looking available model is chosen so those steps stay quick;
 * with none installed it falls back to the reasoning model, so nothing breaks.
 */
export async function selectStructureModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const configured = vscode.workspace.getConfiguration("prAnalyzer").get<string>("structureModel", "");
  return findModel(models, configured) ?? models.find(looksFast) ?? selectModel();
}

export async function pickStructureModel(): Promise<string | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (models.length === 0) {
    void vscode.window.showWarningMessage("No Copilot model is available.");
    return undefined;
  }

  const current = vscode.workspace.getConfiguration("prAnalyzer").get<string>("structureModel", "");
  const auto = models.find(looksFast);
  const items: (vscode.QuickPickItem & { value: string })[] = [
    {
      label: "Fastest available (automatic)",
      description: auto ? `currently ${auto.name}` : "no small model found; uses the main model",
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
