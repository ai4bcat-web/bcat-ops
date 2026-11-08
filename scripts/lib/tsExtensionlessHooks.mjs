/**
 * Node resolve hook: lets a script import `src/**` TypeScript whose own imports are extensionless
 * (`from './proNumber'`), the way the Vite/tsc build writes them. Only a relative specifier that fails to resolve
 * is retried with `.ts`; nothing else changes. Registered by scripts/awBackfillShipments.mjs.
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
