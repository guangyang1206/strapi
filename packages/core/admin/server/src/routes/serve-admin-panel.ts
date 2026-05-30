import type { Context, Next } from 'koa';
import { resolve, join, extname, basename } from 'path';
import fse from 'fs-extra';
import koaStatic from 'koa-static';
import type { Core } from '@strapi/types';

const registerAdminPanelRoute = ({ strapi }: { strapi: Core.Strapi }) => {
  let buildDir = resolve(strapi.dirs.dist.root, 'build');

  if (!fse.pathExistsSync(buildDir)) {
    buildDir = resolve(__dirname, '../../build');
  }

  const serveAdminMiddleware = async (ctx: Context, next: Next) => {
    // Node 26: url.parse() throws ERR_INVALID_ARG_VALUE when the url
    // contains '::' (misinterpreted as IPv6 host). This can happen
    // when ctx.path looks like a content-type ID (e.g. "api::collection.collection").
    // Use a try/catch on next() to prevent the whole request from 500-ing.
    try {
      await next();
    } catch (err: any) {
      if (
        err &&
        err.code === 'ERR_INVALID_ARG_VALUE' &&
        err.message &&
        err.message.includes('url')
      ) {
        // Return 400 instead of 500 for this edge-case URL
        ctx.status = 400;
        ctx.body = 'Bad Request: malformed URL';
        return;
      }
      throw err;
    }

    if (ctx.method !== 'HEAD' && ctx.method !== 'GET') {
      return;
    }

    if (ctx.body != null || ctx.status !== 404) {
      return;
    }

    ctx.type = 'html';
    ctx.body = fse.createReadStream(join(buildDir, 'index.html'));
  };

  strapi.server.routes([
    {
      method: 'GET',
      path: `${strapi.config.admin.path}/:path*`,
      handler: [
        serveAdminMiddleware,
        serveStatic(buildDir, {
          maxage: 31536000,
          defer: false,
          index: 'index.html',
          setHeaders(res: any, path: any) {
            const ext = extname(path);
            // publicly cache static files to avoid unnecessary network & disk access
            if (ext !== '.html') {
              res.setHeader('cache-control', 'public, max-age=31536000, immutable');
            }
          },
        }),
      ],
      config: { auth: false },
    },
  ]);
};

// serveStatic is not supposed to be used to serve a folder that have sub-folders
export const serveStatic = (filesDir: any, koaStaticOptions = {}) => {
  const serve = koaStatic(filesDir, koaStaticOptions);

  return async (ctx: Context, next: Next) => {
    if (!extname(ctx.path)) {
      await next();
      return;
    }

    const prev = ctx.path;
    const newPath = basename(ctx.path);

    ctx.path = newPath;
    await serve(ctx, async () => {
      ctx.path = prev;
      await next();
      ctx.path = newPath;
    });
    ctx.path = prev;
  };
};

export default registerAdminPanelRoute;
