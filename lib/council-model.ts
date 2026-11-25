export function resolveCatalogModel(providerId: string, model: string) {
  const namespace = model.indexOf("/");
  if (providerId === "opencode2" && namespace > 0 && namespace < model.length - 1) {
    return { providerHint: model.slice(0, namespace), modelId: model.slice(namespace + 1) };
  }
  return { providerHint: providerId === "codex" ? "openai" : providerId, modelId: model };
}
