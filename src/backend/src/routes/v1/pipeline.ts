import { Hono } from 'hono';
import { handleUpsertPipeline } from '../../handlers/v1/upsert-pipeline';
import type { ApiKeyAuthVariables } from '../../middleware/api-key-auth';
import type { Env } from '../../index';

/** PUT /:id/pipeline — mounted under /api/v1/projects with api-key-auth. */
const pipelineV1 = new Hono<{
  Bindings: Env;
  Variables: ApiKeyAuthVariables;
}>();

pipelineV1.put('/:id/pipeline', handleUpsertPipeline);

export { pipelineV1 };
