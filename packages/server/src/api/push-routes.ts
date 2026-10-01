import { Router } from 'express';
import type { RuntimeServices } from '../runtime/services.js';

export function createPushRouter(servicesPromise: Promise<RuntimeServices>): Router {
  const router = Router();

  router.get('/public-key', async (_request, response, next) => {
    try {
      const push = (await servicesPromise).pushService;
      response.setHeader('Cache-Control', 'public, max-age=3600');
      response.json({ publicKey: push.getPublicKey(), persistent: push.getStatus().persistent });
    } catch (error) { next(error); }
  });

  router.post('/subscribe', async (request, response, next) => {
    try {
      const result = await (await servicesPromise).pushService.subscribe(
        request.body?.subscription,
        request.body?.categories,
      );
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  router.delete('/subscribe', async (request, response, next) => {
    try {
      const removed = await (await servicesPromise).pushService.unsubscribe(request.body?.endpoint);
      response.status(removed ? 200 : 404).json(removed ? { subscribed: false } : { error: 'Push subscription not found.' });
    } catch (error) { next(error); }
  });

  return router;
}
