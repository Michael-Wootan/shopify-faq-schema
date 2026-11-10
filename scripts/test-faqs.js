#!/usr/bin/env node
// Offline tests for category matching, FAQ filling and the JSON-LD snippet.
// No store needed.
const assert = require('assert');
const path = require('path');
process.env.CONFIG_DIR = path.resolve(__dirname, 'fixtures');
delete process.env.COMPANY_NAME;
const g = require('../src/generate-faqs.js');
const inj = require('../src/inject-faq-schema.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const p = (title, handle, productType = 'Coffee') => ({ title, handle, productType });

t('products are matched to a category by handle, type or title', () => {
  assert.strictEqual(g.detectCategory(p('Water Process Decaf', 'water-process-decaf')), 'decaf');
  assert.strictEqual(g.detectCategory(p('House Espresso Blend', 'house-espresso-blend')), 'espresso');
  assert.strictEqual(g.detectCategory(p('Ethiopia Guji Natural', 'ethiopia-guji-natural')), 'single_origin');
});

t('the first matching category wins, so order decides between overlaps', () => {
  assert.strictEqual(g.detectCategory(p('Decaf Espresso', 'decaf-espresso')), 'decaf');
});

t('wholesale products go to the wholesale category', () => {
  assert.strictEqual(g.detectCategory(p('Wholesale House Espresso 5 lb', 'wholesale-house-espresso-5lb')), 'wholesale');
  assert.strictEqual(g.isWholesale(p('Bulk Colombia', 'bulk-colombia')), true);
  assert.strictEqual(g.isWholesale(p('Colombia Huila', 'colombia-huila')), false);
});

t('exclusions keep unrelated products out of a category', () => {
  assert.strictEqual(g.detectCategory(p('Espresso Machine Cleaner', 'espresso-machine-cleaner', 'Accessories')), null);
});

t('skip handles and unmatched products get no FAQs', () => {
  assert.strictEqual(g.getFaqs(p('Gift Card', 'gift-card', 'Gift Cards')), null);
  assert.strictEqual(g.getFaqs(p('Canvas Tote', 'canvas-tote', 'Merch')), null);
});

t('questions and answers are filled with the product title and brand', () => {
  const faqs = g.getFaqs(p('Ethiopia Guji Natural', 'ethiopia-guji-natural'));
  assert.strictEqual(faqs.length, 3);
  assert.strictEqual(faqs[1].question, 'How should Ethiopia Guji Natural be brewed?');
  const wholesale = g.getFaqs(p('Wholesale House Blend', 'wholesale-house-blend'));
  assert.ok(wholesale[0].answer.includes('Acme Supply Co.'));
  assert.ok(!/\{(title|brand)\}/.test(JSON.stringify([faqs, wholesale])), 'no unfilled tokens');
});

t('the theme snippet renders FAQPage JSON-LD from the product metafield', () => {
  assert.ok(inj.FAQ_SNIPPET.includes('"@type": "FAQPage"'));
  assert.ok(inj.FAQ_SNIPPET.includes('product.metafields.custom.faqs.value'));
  assert.ok(inj.FAQ_SNIPPET.includes('faq_item.question | strip | json'));
  assert.ok(inj.RENDER_TAG.includes(inj.RENDER_MARKER));
});

console.log(`\n${n} tests passed`);
