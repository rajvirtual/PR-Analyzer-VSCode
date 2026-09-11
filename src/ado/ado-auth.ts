import * as vscode from "vscode";
import { bearerHeader, looksLikePat, patHeader } from "./auth-header.js";

/**
 * Signing in to Azure DevOps, two ways.
 *
 * The VS Code account is the pleasant path and needs nothing typed, but it is not
 * available to everyone: an organisation behind conditional access, or an account
 * VS Code cannot broker, leaves a reader with no way in. A personal access token
 * always works, so it is offered as a fallback rather than as the only choice.
 */

/** The Azure DevOps first-party application, whose token the REST API accepts. */
const ADO_SCOPES = ["499b84ac-1321-427f-aa17-267ca6975798/.default", "offline_access"];

const PAT_KEY = "prAnalyzer.azureDevOpsPat";

export class AdoAuthError extends Error {}

let secrets: vscode.SecretStorage | null = null;

export function initialiseAdoAuth(storage: vscode.SecretStorage): void {
  secrets = storage;
}

/** A token is either brokered by VS Code or typed by the reader; the header differs. */
export type Authorization = string;

async function storedPat(): Promise<string | undefined> {
  return secrets?.get(PAT_KEY);
}

async function session(createIfNone: boolean): Promise<string | undefined> {
  try {
    const found = await vscode.authentication.getSession("microsoft", ADO_SCOPES, {
      createIfNone,
      silent: createIfNone ? undefined : true,
    });
    return found?.accessToken;
  } catch {
    // A provider that cannot serve this account is a reason to offer the token, not to fail.
    return undefined;
  }
}

/**
 * The header to send, asking only when there is no other way.
 *
 * A stored token is preferred over signing in interactively: a reader who supplied
 * one has already told us which way they want to authenticate.
 */
export async function authorization(interactive: boolean): Promise<Authorization> {
  const pat = await storedPat();
  if (pat) return patHeader(pat);

  const silent = await session(false);
  if (silent) return bearerHeader(silent);

  if (!interactive) throw new AdoAuthError("Not signed in to Azure DevOps.");

  const chosen = await signIn();
  if (!chosen) throw new AdoAuthError("Not signed in to Azure DevOps.");
  return chosen;
}

/** Offers both routes, and remembers a token so it is typed once. */
export async function signIn(): Promise<Authorization | null> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(account) Use my VS Code account",
        detail: "Signs in with the Microsoft account VS Code already knows",
        id: "account" as const,
      },
      {
        label: "$(key) Use a personal access token",
        detail: "For organisations the account sign-in cannot reach. Needs Code (read)",
        id: "pat" as const,
      },
    ],
    { title: "Sign in to Azure DevOps", ignoreFocusOut: true },
  );
  if (!choice) return null;

  if (choice.id === "account") {
    const token = await session(true);
    if (!token) throw new AdoAuthError("Azure DevOps sign-in was not completed.");
    // A stale token would otherwise keep winning over the account just chosen.
    await secrets?.delete(PAT_KEY);
    return bearerHeader(token);
  }

  const pat = await vscode.window.showInputBox({
    title: "Azure DevOps personal access token",
    prompt: "Create one under User settings > Personal access tokens, with Code (read)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      looksLikePat(value) ? null : "That does not look like a token. Paste it, or press Escape",
  });
  if (!pat?.trim()) return null;

  await secrets?.store(PAT_KEY, pat.trim());
  return patHeader(pat.trim());
}

export async function signOut(): Promise<void> {
  await secrets?.delete(PAT_KEY);
}

export async function hasStoredToken(): Promise<boolean> {
  return (await storedPat()) !== undefined;
}
