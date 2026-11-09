/**
 * Node resolve hook: lets a script import `src/**` TypeScript whose own imports are extensionless
 * (`from './proNumber'`), the way the Vite/tsc build writes them. Only a relative specifier that fails to resolve
 * is retried with `.ts`; nothing else changes (plus the json import attribute, below). Registered by scripts/awBackfillShipments.mjs and awCarriers.mjs.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    throw err;
  }
}

/** `import X from './data.json'` in `src/**` is written for the bundler; Node wants the `type: 'json'` attribute, so it is supplied here. */
export async function load(url, context, next) {
  if (url.endsWith('.json') && !context.importAttributes?.type) {
    return next(url, { ...context, importAttributes: { ...context.importAttributes, type: 'json' } });
  }
  return next(url, context);
}
