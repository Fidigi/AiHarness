import { MockProvider, SpecializedModels } from '@ai-harness/core';

const provider = new MockProvider({ type: 'mock', model: 'contract-chat' }, ['{"label":"safe"}']);
const models = new SpecializedModels(provider);
const classifier = models.getModelOfType('classifier');
const result = await models.classify({ model: classifier.id, input: 'contract input', labels: ['safe', 'unsafe'] });
const image = await models.generateImages({ model: models.getModelOfType('image').id, prompt: 'one fixture pixel' });
const negatives = [];
for (const request of [
  { model: classifier.id, input: 'x', labels: ['safe'], apiKey: 'must-not-execute' },
  { model: 'mock-image', input: 'x', labels: ['safe'] },
]) {
  try { await models.classify(request); negatives.push('unexpected success'); }
  catch (error) { negatives.push(error.message); }
}
console.log(JSON.stringify({ classifier, label: result.label, images: image.images, negatives, conversationalModel: provider.getConfiguredModel() }));
