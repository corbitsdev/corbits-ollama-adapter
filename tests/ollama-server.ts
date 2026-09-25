// Opt-in: live suites skip unless OLLAMA_BASE_URL names the server (e.g. http://host:11434).
export const OLLAMA_ROOT_URL = process.env["OLLAMA_BASE_URL"] ?? "";
export const OLLAMA_V1_BASE_URL = `${OLLAMA_ROOT_URL}/v1`;

export async function modelIsPulled(model: string): Promise<boolean> {
  if (OLLAMA_ROOT_URL === "") return false;
  try {
    const res = await fetch(`${OLLAMA_ROOT_URL}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("models" in body)) {
      return false;
    }
    const models: unknown = body.models;
    return (
      Array.isArray(models) &&
      models.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "name" in entry &&
          entry.name === model,
      )
    );
  } catch {
    return false;
  }
}
