#!/usr/bin/env node
/**
 * inject-faq-schema.js: adds FAQ JSON-LD to the published Shopify theme
 *
 *   1. Finds the published theme
 *   2. Creates or updates snippets/faq-schema.liquid (the FAQPage JSON-LD renderer)
 *   3. Finds the product template or section and adds the render tag if it is not there
 *
 * Usage:
 *   node src/inject-faq-schema.js --dry-run  preview only
 *   node src/inject-faq-schema.js            apply to the published theme
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const STORE = process.env.SHOPIFY_STORE || '';
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');
const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '..', 'backups');

// Save the original of a theme file before the first change to it
function backup(key, content) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, key.replace(/[\\/]/g, '__'));
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}

const BASE = `https://${STORE}/admin/api/2025-07`;
const HEADERS = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json'
};

async function shopifyREST(path, method = 'GET', body = null) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── The FAQ snippet in Liquid ─────────────────────────────────────────────────
const FAQ_SNIPPET = `{%- comment -%}
  faq-schema.liquid
  Renders FAQ JSON-LD (FAQPage) schema from the product's custom.faqs metafield.
  Include via: {%- render 'faq-schema', product: product -%}
{%- endcomment -%}

{%- assign faq_list = product.metafields.custom.faqs.value -%}
{%- if faq_list and faq_list.size > 0 -%}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {%- for faq_item in faq_list -%}
    {
      "@type": "Question",
      "name": {{ faq_item.question | strip | json }},
      "acceptedAnswer": {
        "@type": "Answer",
        "text": {{ faq_item.answer | strip | json }}
      }
    }{%- unless forloop.last -%},{%- endunless -%}
    {%- endfor -%}
  ]
}
</script>
{%- endif -%}
`;

// ── Render tag to inject into product template ────────────────────────────────
const RENDER_TAG = "\n{%- render 'faq-schema', product: product -%}";
const RENDER_MARKER = "faq-schema";

async function run() {
  if (!TOKEN) { console.error('Missing SHOPIFY_ADMIN_TOKEN in .env'); process.exit(1); }
  console.log(`\n${'='.repeat(56)}`);
  console.log(`  FAQ Schema Theme Injection`);
  console.log(`  Mode: ${DRY_RUN ? '👁  DRY RUN' : '🚀 LIVE'}`);
  console.log(`${'='.repeat(56)}\n`);

  // 1. Get published theme
  console.log('Finding published theme...');
  const { themes } = await shopifyREST('/themes.json');
  const mainTheme = themes.find(t => t.role === 'main');
  if (!mainTheme) throw new Error('No published (main) theme found');
  console.log(`  ✓ Theme: "${mainTheme.name}" (id: ${mainTheme.id})\n`);

  // 2. Upload the FAQ snippet
  const snippetKey = 'snippets/faq-schema.liquid';
  console.log(`Uploading ${snippetKey}...`);
  if (!DRY_RUN) {
    await shopifyREST(`/themes/${mainTheme.id}/assets.json`, 'PUT', {
      asset: { key: snippetKey, value: FAQ_SNIPPET }
    });
    console.log(`  ✓ Snippet uploaded\n`);
  } else {
    console.log(`  [DRY RUN] Would upload snippet\n`);
  }

  // 3. Get all theme assets to find the product template(s)
  console.log('Fetching theme assets list...');
  const { assets } = await shopifyREST(`/themes/${mainTheme.id}/assets.json`);

  // Find product template(s) - could be templates/product.liquid or sections/main-product.liquid
  const productTemplates = assets.filter(a =>
    (a.key.startsWith('templates/product') || a.key.startsWith('sections/main-product')) &&
    (a.key.endsWith('.liquid') || a.key.endsWith('.json'))
  );
  console.log(`  Found ${productTemplates.length} product template(s): ${productTemplates.map(a => a.key).join(', ')}\n`);

  // 4. For each product template, check if render tag is already there; if not, add it
  for (const tmpl of productTemplates) {
    console.log(`Processing: ${tmpl.key}`);

    // Get the asset content
    const { asset } = await shopifyREST(
      `/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(tmpl.key)}`
    );

    // JSON templates (sections-based themes): we don't modify these directly
    if (tmpl.key.endsWith('.json')) {
      console.log(`  ↳ JSON template: skipping (sections-based theme; snippet added to sections/main-product.liquid instead)\n`);
      continue;
    }

    const content = asset.value || '';

    if (content.includes(RENDER_MARKER)) {
      console.log(`  ✓ Already has faq-schema render tag: skipping\n`);
      continue;
    }

    // Inject before closing </body> or at end of file
    let newContent;
    if (content.includes('</body>')) {
      newContent = content.replace('</body>', `${RENDER_TAG}\n</body>`);
    } else {
      newContent = content + RENDER_TAG;
    }

    console.log(`  → Injecting render tag...`);
    if (!DRY_RUN) {
      backup(tmpl.key, content);
      await shopifyREST(`/themes/${mainTheme.id}/assets.json`, 'PUT', {
        asset: { key: tmpl.key, value: newContent }
      });
      console.log(`  ✓ Done\n`);
    } else {
      console.log(`  [DRY RUN] Would inject render tag into ${tmpl.key}\n`);
    }
  }

  // 5. Also check sections/main-product.liquid specifically (common in Dawn/Debut)
  const mainProductSection = assets.find(a => a.key === 'sections/main-product.liquid');
  if (mainProductSection) {
    console.log(`Processing: sections/main-product.liquid`);
    const { asset } = await shopifyREST(
      `/themes/${mainTheme.id}/assets.json?asset[key]=sections%2Fmain-product.liquid`
    );
    const content = asset.value || '';

    if (content.includes(RENDER_MARKER)) {
      console.log(`  ✓ Already has faq-schema render tag: skipping\n`);
    } else {
      // Inject just before the closing schema tag or at the end of the section
      let newContent;
      if (content.includes('{% schema %}')) {
        newContent = content.replace('{% schema %}', `${RENDER_TAG}\n\n{% schema %}`);
      } else if (content.includes('{%- schema -%}')) {
        newContent = content.replace('{%- schema -%}', `${RENDER_TAG}\n\n{%- schema -%}`);
      } else {
        newContent = content + RENDER_TAG;
      }

      console.log(`  → Injecting render tag into sections/main-product.liquid...`);
      if (!DRY_RUN) {
        backup('sections/main-product.liquid', content);
        await shopifyREST(`/themes/${mainTheme.id}/assets.json`, 'PUT', {
          asset: { key: 'sections/main-product.liquid', value: newContent }
        });
        console.log(`  ✓ Done\n`);
      } else {
        console.log(`  [DRY RUN] Would inject into sections/main-product.liquid\n`);
      }
    }
  }

  console.log(`${'='.repeat(56)}`);
  console.log(`  ✅ FAQ Schema injection complete!`);
  console.log(`${'='.repeat(56)}\n`);
  console.log('Next: check a product page with the Rich Results Test.\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { FAQ_SNIPPET, RENDER_TAG, RENDER_MARKER };
