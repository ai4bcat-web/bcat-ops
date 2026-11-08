/**
 * Which data models the deployed AppSync schema has.
 *
 * The schema ships in stages (amplify/data/stages.ts, Docs/tms-build/AW_STAGED_DEPLOY.md): until a
 * stage deploys, its models are absent from the generated schema and a query on them is a GraphQL
 * validation error. Every stage's build regenerates `amplify_outputs.json`, and
 * `data.model_introspection.models` lists exactly the models that stage contains, so the same file
 * `main.tsx` hands to `Amplify.configure` answers "is this table there yet?" with no network call.
 *
 * No introspection in the file (the placeholder, a dev sandbox without it, tests) means "assume
 * everything is deployed": the guard only ever hides a surface the schema provably lacks.
 */
import amplifyOutputs from '../../amplify_outputs.json'

/** The slice of `amplify_outputs.json` this module reads. */
export interface AmplifyOutputsLike {
  data?: { model_introspection?: { models?: Record<string, unknown> | null } | null } | null
}

const bundled = amplifyOutputs as unknown as AmplifyOutputsLike

function deployedModels(outputs: AmplifyOutputsLike): Record<string, unknown> | null {
  const models = outputs.data?.model_introspection?.models
  return models && typeof models === 'object' ? models : null
}

/** True when `name` is in the deployed schema, or when the outputs carry no introspection. */
export function modelAvailable(name: string, outputs: AmplifyOutputsLike = bundled): boolean {
  const models = deployedModels(outputs)
  return models === null || Object.hasOwn(models, name)
}

/** True when every named model is deployed. An empty list is trivially true. */
export function modelsAvailable(names: readonly string[], outputs: AmplifyOutputsLike = bundled): boolean {
  const models = deployedModels(outputs)
  return models === null || names.every((name) => Object.hasOwn(models, name))
}
