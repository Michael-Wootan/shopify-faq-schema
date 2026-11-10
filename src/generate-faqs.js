#!/usr/bin/env node
/**
 * generate-faqs.js: FAQ metaobjects for every product that has none
 *
 * Assigns each active product to a category from config/faq-library.json,
 * creates that category's questions and answers as faq_item metaobjects, and
 * links them to the product through the custom.faqs metafield. Products that
 * already have FAQs are left alone. Uses the GraphQL Admin API only.
 *
 * Usage:
 *   node src/generate-faqs.js --audit            dry run: which products get which category
 *   node src/generate-faqs.js                    live push
 *   node src/generate-faqs.js --category decaf   restrict to one category
 *   node src/generate-faqs.js --limit 10         process at most N products
 *
 * Token scopes: read/write products, metaobjects and metafields.
 */

require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');

const STORE    = process.env.SHOPIFY_STORE   || '';
const TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const GQL_VER  = '2024-10';
const GQL_URL  = `https://${STORE}/admin/api/${GQL_VER}/graphql.json`;
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
const STATE_DIR  = process.env.STATE_DIR  || path.resolve(__dirname, '..', 'state');
const STATE_FILE = path.join(STATE_DIR, 'faq-state.json');

// ─────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const IS_AUDIT    = args.includes('--audit');
const LIMIT       = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i+1],10) : Infinity; })();
const CAT_FILTER  = (() => { const i = args.indexOf('--category'); return i >= 0 ? args[i+1] : null; })();

// ─────────────────────────────────────────────────────────
// State persistence (skip already-done products on retry)
// ─────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { done: {} }; }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────────────────
// GraphQL helper
// ─────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method:  'POST',
    headers: {
      'Content-Type':              'application/json',
      'X-Shopify-Access-Token':    TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ─────────────────────────────────────────────────────────
// Fetch ALL active products (cursor-paginated)
// Includes metafield check so we skip already-populated products
// ─────────────────────────────────────────────────────────
async function fetchAllProducts() {
  const QUERY = `
    query getProducts($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            status
            productType
            metafield(namespace: "custom", key: "faqs") {
              id
              value
            }
          }
        }
      }
    }
  `;

  const products = [];
  let cursor = null;

  while (true) {
    const data = await gql(QUERY, { cursor });
    const page = data.products;
    for (const { node } of page.edges) products.push(node);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    await sleep(300);
  }

  return products;
}

// ─────────────────────────────────────────────────────────
// FAQ library: config/faq-library.json (falls back to the example)
//   skipHandles:  handle fragments that never get FAQs (gift cards and so on)
//   categories:   checked in order, first match wins. Each has:
//     name
//     match: { any: [fragments], not: [fragments], wholesale: true|false }
//            fragments are tested against the handle, product type and title;
//            "wholesale" restricts the category to wholesale or non-wholesale products
//     faqs:  [{ question, answer }]; {title} and {brand} are filled in
// Order the categories from specific to general.
// ─────────────────────────────────────────────────────────
function loadLibrary() {
  for (const f of ['faq-library.json', 'faq-library.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/faq-library.json');
}
const LIBRARY = loadLibrary();
const BRAND   = process.env.COMPANY_NAME || LIBRARY.brand || 'our store';

function productText(product) {
  return [product.handle, product.productType, product.title].map(v => (v || '').toLowerCase()).join(' | ').replace(/-/g, ' ');
}

function isWholesale(product) {
  return /\b(wholesale|bulk)\b/.test(productText(product));
}

// ─────────────────────────────────────────────────────────
// Category detection
// ─────────────────────────────────────────────────────────
function findCategory(product) {
  const text = productText(product);
  const has = frag => text.includes(String(frag).toLowerCase().replace(/-/g, ' '));
  if ((LIBRARY.skipHandles || []).some(has)) return null;
  const wholesale = isWholesale(product);
  for (const cat of LIBRARY.categories || []) {
    const m = cat.match || {};
    if (m.wholesale !== undefined && m.wholesale !== wholesale) continue;
    if (m.not && m.not.some(has)) continue;
    if (m.any && !m.any.some(has)) continue;
    return cat;
  }
  return null;
}

function detectCategory(product) {
  const cat = findCategory(product);
  return cat ? cat.name : null;
}

function getFaqs(product) {
  const cat = findCategory(product);
  if (!cat || !cat.faqs || !cat.faqs.length) return null;
  const fill = s => String(s).replace(/\{title\}/g, product.title || '').replace(/\{brand\}/g, BRAND);
  return cat.faqs.map(f => ({ question: fill(f.question), answer: fill(f.answer) }));
}

// ─────────────────────────────────────────────────────────
// Create a single faq_item metaobject
// Returns the GID string on success
// ─────────────────────────────────────────────────────────
async function createFaqItem(question, answer) {
  const MUTATION = `
    mutation CreateFaqItem($fields: [MetaobjectFieldInput!]!) {
      metaobjectCreate(metaobject: {
        type: "faq_item",
        fields: $fields,
        capabilities: {
          publishable: {
            status: ACTIVE
          }
        }
      }) {
        metaobject { id }
        userErrors { field message code }
      }
    }
  `;

  const data = await gql(MUTATION, {
    fields: [
      { key: 'question', value: question },
      { key: 'answer',   value: answer   },
    ],
  });

  const result = data.metaobjectCreate;
  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(`metaobjectCreate errors: ${JSON.stringify(result.userErrors)}`);
  }
  return result.metaobject.id;  // "gid://shopify/Metaobject/12345"
}

// ─────────────────────────────────────────────────────────
// Assign list of FAQ metaobject GIDs to a product's custom.faqs metafield
// ─────────────────────────────────────────────────────────
async function assignFaqsToProduct(productGid, faqGids) {
  const MUTATION = `
    mutation SetFaqMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message code }
      }
    }
  `;

  // The value must be a JSON array of GID strings
  const value = JSON.stringify(faqGids);

  const data = await gql(MUTATION, {
    metafields: [{
      ownerId:   productGid,
      namespace: 'custom',
      key:       'faqs',
      type:      'list.metaobject_reference',
      value,
    }],
  });

  const result = data.metafieldsSet;
  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(`metafieldsSet errors: ${JSON.stringify(result.userErrors)}`);
  }
  return result.metafields[0];
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg)  { console.log(msg); }

// ─────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────
async function main() {
  log('');
  log('══════════════════════════════════════════════════════');
  if (!TOKEN) { console.error('❌  SHOPIFY_ADMIN_TOKEN not set'); process.exit(1); }
  log('  FAQ Metafield Injection');
  log(`  Mode: ${IS_AUDIT ? '🔍 AUDIT (dry-run)' : '🚀 LIVE PUSH'}`);
  if (CAT_FILTER) log(`  Category filter: ${CAT_FILTER}`);
  if (LIMIT < Infinity) log(`  Limit: ${LIMIT} products`);
  log('══════════════════════════════════════════════════════');
  log('');

  const state = loadState();

  log('Fetching all active products from Shopify...');
  const products = await fetchAllProducts();
  log(`  ✓ ${products.length} active products retrieved`);
  log('');

  // ── Categorize products ──────────────────────────────────
  const toProcess = [];
  const skipped   = { already_has_faqs: [], no_category: [], state_done: [] };

  for (const product of products) {
    const stateKey = `product-${product.id}`;

    // Skip if already done in a previous run
    if (state.done[stateKey] === 'ok') {
      skipped.state_done.push(product.title);
      continue;
    }

    // Skip products that already have custom.faqs
    if (product.metafield && product.metafield.value) {
      skipped.already_has_faqs.push(product.title);
      continue;
    }

    const cat  = detectCategory(product);
    const faqs = getFaqs(product);

    if (!cat || !faqs) {
      skipped.no_category.push(`${product.title} (${product.handle})`);
      continue;
    }

    if (CAT_FILTER && cat !== CAT_FILTER) continue;

    toProcess.push({ product, cat, faqs });
  }

  // ── Audit report ─────────────────────────────────────────
  log('─── SUMMARY ─────────────────────────────────────────');
  log(`  Already have FAQs:       ${skipped.already_has_faqs.length} products (skipping)`);
  log(`  No matching category:    ${skipped.no_category.length} products (skipping)`);
  log(`  Previously completed:    ${skipped.state_done.length} products (skipping)`);
  log(`  To process now:          ${Math.min(toProcess.length, LIMIT)} products`);
  log('');

  if (skipped.no_category.length > 0) {
    log('─── Products with NO matching category ──────────────');
    skipped.no_category.forEach(t => log(`  ⚠  ${t}`));
    log('');
  }

  if (IS_AUDIT) {
    log('─── AUDIT: Products that WILL get FAQs ──────────────');
    let count = 0;
    for (const { product, cat } of toProcess) {
      if (count >= LIMIT) break;
      log(`  • [${cat}]  ${product.title}`);
      count++;
    }
    log('');
    log('─── AUDIT: Already-populated products ───────────────');
    skipped.already_has_faqs.forEach(t => log(`  ✓  ${t}`));
    log('');
    log('Run without --audit to execute the live push.');
    return;
  }

  // ── Live push ────────────────────────────────────────────
  let processed = 0;
  let errors     = 0;

  for (const { product, cat, faqs } of toProcess) {
    if (processed >= LIMIT) break;

    const stateKey = `product-${product.id}`;
    process.stdout.write(`  [${processed + 1}/${Math.min(toProcess.length, LIMIT)}] ${product.title} (${cat}) ... `);

    try {
      // 1. Create each faq_item metaobject
      const gids = [];
      for (const faq of faqs) {
        const gid = await createFaqItem(faq.question, faq.answer);
        gids.push(gid);
        await sleep(150);
      }

      // 2. Assign GIDs to product metafield
      await assignFaqsToProduct(product.id, gids);

      state.done[stateKey] = 'ok';
      saveState(state);

      console.log(`✓  (${faqs.length} FAQs created)`);
    } catch (err) {
      console.log(`✗  ERROR: ${err.message}`);
      errors++;
    }

    processed++;
    await sleep(400);  // Stay well within Shopify rate limits (4 req/s GraphQL)
  }

  log('');
  log('══════════════════════════════════════════════════════');
  log(`  Done!  Processed: ${processed}  |  Errors: ${errors}`);
  log('══════════════════════════════════════════════════════');
  log('');

  if (errors > 0) {
    log('⚠  Some products failed. Re-run the script: already-completed products');
    log('   are saved in the state file and will be skipped automatically.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { detectCategory, getFaqs, isWholesale };
