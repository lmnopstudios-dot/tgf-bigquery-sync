/**
 * Governed, exact Shopify product_type -> broad product_category contract.
 *
 * This is intentionally data rather than query logic. Matching is exact after
 * trimming surrounding whitespace; unknown and blank values are never guessed.
 * The original product_type is retained independently as catalogue evidence.
 */
const groups = Object.freeze({
  ring: ['Rings'],
  pendant: ['Pendants'],
  bracelet: ['Bracelets'],
  earrings: ['Earrings'],
  necklace: ['Necklaces'],
  chain: ['Chains'],
  gift_voucher: ['Gift Voucher'],
  clothing: ['Clothing', 'T-Shirts', 'Hoodies', 'Pants', 'Socks', 'Caps', 'Scarfs', 'Bandanas', 'Baby Grows'],
  accessory: ['Sunglasses', 'Optical Glasses', 'Charms', 'Wallet Chains', 'Tote Bags', 'Cufflinks', 'Key Rings', 'Wallets', 'Buckles', 'Bolo Ties', 'Motorbike Accessories', 'Helmet Poppers', 'Patches', 'Badges', 'Valve Caps'],
  other: ['Ring Sizer', 'Mugs', 'Incense', 'Greetings Cards', 'Boots', 'Blankets', 'Bespoke', 'Slip Mats', 'Posters', 'Polishing Clothes', 'Bottle Openers']
});

export const SHOPIFY_PRODUCT_TYPE_MAPPING = Object.freeze(Object.entries(groups).flatMap(([classification_value, values]) =>
  values.map(source_value => Object.freeze({
    source: 'shopify',
    classification_type: 'product_category',
    source_field: 'product_type',
    source_value,
    classification_value,
    provenance: 'governed_shopify_product_type_mapping'
  }))
));

const byValue = new Map(SHOPIFY_PRODUCT_TYPE_MAPPING.map(row => [row.source_value, row]));

export function normalizeShopifyProductType(value) {
  if (value === null || value === undefined || !String(value).trim()) return null;
  return byValue.get(String(value).trim()) || null;
}

export function serializeShopifyProductTypeMapping() {
  return JSON.parse(JSON.stringify(SHOPIFY_PRODUCT_TYPE_MAPPING));
}
