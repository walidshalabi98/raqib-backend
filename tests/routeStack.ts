import type { Express } from 'express';

export interface RouteLayer {
  /** "method path", e.g. "post /api/projects/:id/documents". */
  key: string;
  method: string;
  path: string;
  /** The route's own middleware and handlers, in order (layer.route.stack handles). */
  handlers: any[];
  /** Middleware of the routers the route is mounted in (router.use), outermost first. */
  routerMiddleware: any[];
}

/** A layer that is not a route and holds no routes: middleware, a mounted sub-app, a wrapped router, a static mount. */
export interface MiddlewareLayer {
  /** Mount path ('' for every path). */
  path: string;
  /** The Express layer name (the function's name, 'mounted_app' for a sub-app, '<anonymous>'). */
  name: string;
  handle: unknown;
}

export interface AppStack {
  routes: RouteLayer[];
  /** Every other layer, in the order Express runs them. tests/roles.test.ts compares it with a reviewed list. */
  middleware: MiddlewareLayer[];
}

const mountPath = (layer: any): string => {
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  return src.replace('^', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
};

/**
 * Walks every layer of the app. A layer with a route is an endpoint; a layer whose handle has its own stack
 * (a router, whatever its name) is walked into; every other layer is returned as middleware, so an endpoint
 * written as `app.use(path, handler)`, a sub-app (`mounted_app`) or a router hidden behind a wrapper
 * function shows up there and fails the reviewed list instead of escaping the role checks.
 */
export function appStack(app: Express): AppStack {
  const routes: RouteLayer[] = [];
  const middleware: MiddlewareLayer[] = [];
  type Mounted = { handle: any; path: string };
  const walk = (stack: any[], prefix: string, inherited: Mounted[]) => {
    const routerLevel: Mounted[] = [];
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          const path = `${prefix}${layer.route.path}`;
          routes.push({
            key: `${method} ${path}`,
            method,
            path,
            handlers: layer.route.stack.map((l: any) => l.handle),
            // Only middleware mounted on a prefix of this route's path runs for it.
            routerMiddleware: [...inherited, ...routerLevel].filter(m => path.startsWith(m.path)).map(m => m.handle),
          });
        }
      } else if (Array.isArray(layer.handle?.stack)) {
        walk(layer.handle.stack, prefix + mountPath(layer), [...inherited, ...routerLevel]);
      } else {
        const path = prefix + mountPath(layer);
        routerLevel.push({ handle: layer.handle, path });
        middleware.push({ path, name: String(layer.name ?? ''), handle: layer.handle });
      }
    }
  };
  walk((app as any)._router.stack, '', []);
  return { routes, middleware };
}

/** Every route registered on the app with its handler stack. */
export function routeLayers(app: Express): RouteLayer[] {
  return appStack(app).routes;
}
