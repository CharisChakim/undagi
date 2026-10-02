import { parseAntigravityModels, parseClaudeSupportedModels, type ParsedRuntimeModel } from "./parse.ts";
import { runMetadataCommand } from "./process.ts";

export interface ClaudeSdkMetadataProvider {
  /**
   * Thin boundary for the pinned Claude Agent SDK `supportedModels()` call.
   * `executablePath` is the `claude` binary discovery found.
   */
  supportedModels(executablePath?: string): Promise<unknown> | unknown;
}

export interface AdapterMetadataOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RuntimeAdapterMetadata {
  ok: boolean;
  models: ParsedRuntimeModel[];
  defaultModel: string | null;
  defaultEffort: string | null;
  authScope: string | null;
  authRequired: boolean;
  diagnostic: string | null;
}

function authError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|login|credential|unauthori|forbidden|token/i.test(message);
}

/** Discover Claude models only through the official SDK boundary. */
export async function queryClaudeSdk(
  provider: ClaudeSdkMetadataProvider | undefined,
  executablePath?: string,
): Promise<RuntimeAdapterMetadata> {
  if (!provider) {
    return {
      ok: false,
      models: [],
      defaultModel: null,
      defaultEffort: null,
      authScope: null,
      authRequired: false,
      diagnostic: "CLAUDE_SDK_NOT_CONFIGURED",
    };
  }
  try {
    const models = parseClaudeSupportedModels(await provider.supportedModels(executablePath));
    return {
      ok: models.length > 0,
      models,
      defaultModel: null,
      defaultEffort: null,
      authScope: models.find((model) => model.authScope)?.authScope ?? null,
      authRequired: false,
      diagnostic: models.length > 0 ? null : "MODEL_CATALOG_EMPTY",
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      defaultModel: null,
      defaultEffort: null,
      authScope: null,
      authRequired: authError(error),
      diagnostic: authError(error) ? "AUTH_REQUIRED" : "SDK_METADATA_ERROR",
    };
  }
}

/** Discover AGY models using the documented non-prompt `agy models` command. */
export async function queryAntigravityCli(
  executable: string,
  options: AdapterMetadataOptions = {},
): Promise<RuntimeAdapterMetadata> {
  const result = await runMetadataCommand(executable, ["models"], {
    ...options,
    stdin: "ignore",
  });
  const models = result.ok ? parseAntigravityModels(result.stdout) : [];
  const authRequired = /auth|login|credential|unauthori|forbidden|token/i.test(result.stderr);
  return {
    ok: result.ok && models.length > 0,
    models,
    defaultModel: null,
    defaultEffort: null,
    authScope: null,
    authRequired,
    diagnostic: result.ok
      ? (models.length > 0 ? null : "MODEL_CATALOG_EMPTY")
      : (result.timedOut ? "METADATA_TIMEOUT" : (authRequired ? "AUTH_REQUIRED" : (result.errorCode ?? "COMMAND_FAILED"))),
  };
}
