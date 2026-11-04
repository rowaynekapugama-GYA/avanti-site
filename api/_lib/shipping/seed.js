// Starting shipping settings, from the client's Shipping Calculator Specification v1.0 (3 Nov 2026).
// This is seed data only: the live settings are stored as versions in the database and edited in
// the dashboard (Shipping). Values marked `verify: true` are provisional and need client sign-off.
//
// Units: money in cents, percentages in basis points (1500 = 15%), lengths in mm, weights in grams.

const bandRates = (small, medium, large, os1, os2) => ({ small, medium, large, os1, os2 });
const WIDTH_TIERS = [   // section 4: second-longest packed dimension
  { up_to_mm: 600, bps: 0 }, { up_to_mm: 900, bps: 1500 }, { up_to_mm: 1200, bps: 3000 }, { up_to_mm: null, bps: 5000 }];
const WEIGHT_TIERS = [  // section 5: packed weight per package
  { up_to_g: 5000, cents: 0 }, { up_to_g: 10000, cents: 1000 }, { up_to_g: 15000, cents: 2000 }, { up_to_g: 20000, cents: 3500 }];
const PENDING = { status: 'provisional', by: null, at: null };

// Metro postcode ranges: Shippit, "Rule to allocate a courier for metro and regional destinations"
// (support.shippit.com/en/articles/8942194). Requires client verification. Brisbane is limited to the
// core metro ranges; Shippit's wider "Brisbane" list (Gold Coast, Sunshine Coast, Tweed) is kept as a
// separate disabled zone so those areas are never priced at Brisbane metro rates by accident.
const zone = (id, name, state, cls, ranges, rates, enabled, source) => ({
  id, name, state, class: cls, subzone: null, ranges, enabled, approval: { ...PENDING },
  rates: rates || bandRates(null, null, null, null, null),
  width_tiers: WIDTH_TIERS.map(t => ({ ...t })), weight_tiers: WEIGHT_TIERS.map(t => ({ ...t })),
  feasibility: null, verify: true, source: source || null,
});
const SHIPPIT = 'Shippit metro ranges (support.shippit.com/en/articles/8942194), requires client verification';

export const SEED = {
  schema: 1,
  note: 'Seeded from the client Shipping Calculator Specification v1.0 (3 Nov 2026). Rates are provisional test rates, not approved live rates.',

  pricing: {
    freight_markup_bps: 1500,          // 15% on the discounted base freight subtotal
    packaging_markup_bps: 2000,        // 20% on total packaging cost
    additional_package_bps: 7500,      // every package after the highest-base one pays 75% of its base
    oversized_discount_eligible: true, // may Oversized 1/2 packages get the additional-package rate?
    minimum_ex_gst_cents: 1500,        // $15 ex GST
    rounding: 'ceil_dollar',           // always round up to the next whole dollar
    gst_bps: 1000,                     // GST added separately at checkout
  },

  bands: [
    { key: 'small', label: 'Small', up_to_mm: 600 },
    { key: 'medium', label: 'Medium', up_to_mm: 1000 },
    { key: 'large', label: 'Large', up_to_mm: 1500 },
    { key: 'os1', label: 'Oversized 1', up_to_mm: 2000 },
    { key: 'os2', label: 'Oversized 2', up_to_mm: null },
  ],

  // Carrier/package feasibility: packages beyond these are not priced (unavailable, not a cheaper rate).
  // Can be overridden per zone (zone.feasibility). Provisional.
  feasibility: { max_length_mm: 2500, max_width_mm: 1300, max_height_mm: 600, max_weight_g: 20000, verify: true },

  zones: [
    zone('syd-metro', 'Sydney Metro', 'NSW', 'metro', [[1000, 1920], [2000, 2239], [2555, 2574], [2740, 2786]], bandRates(1100, 1600, 3000, 8500, 12500), true, SHIPPIT),
    zone('mel-metro', 'Melbourne Metro', 'VIC', 'metro', [[3000, 3207], [3335, 3341], [3750, 3810], [3910, 3920], [3926, 3944], [3975, 3978], [3980, 3981], [8000, 8785]], bandRates(1400, 1900, 4000, 10500, 15000), true, SHIPPIT),
    zone('bne-metro', 'Brisbane Metro', 'QLD', 'metro', [[4000, 4207], [4300, 4305], [4500, 4519], [9016, 9464]], bandRates(1500, 2200, 4000, 11000, 15500), true, SHIPPIT + ' (core ranges only)'),
    zone('adl-metro', 'Adelaide Metro', 'SA', 'metro', [[5000, 5171], [5800, 5950]], bandRates(1700, 2500, 4500, 11500, 16500), true, SHIPPIT),
    zone('cbr-act', 'Canberra / ACT', 'ACT', 'metro', [[200, 250], [2600, 2620], [2900, 2914]], bandRates(1400, 2000, 3800, 10000, 14500), true, SHIPPIT),
    // not approved for launch: disabled, no rates (never copied from another zone)
    zone('seq-outer', 'South East QLD outer (Gold Coast, Sunshine Coast, Tweed)', 'QLD', 'regional', [[2484, 2490], [4208, 4299], [4306, 4370], [4373, 4381], [4400, 4405], [4520, 4580], [4600, 4610], [4614, 4615], [9726, 9726]], null, false, 'Shippit wider Brisbane list'),
    zone('per-metro', 'Perth Metro', 'WA', 'metro', [[6000, 6214], [6800, 6997]], null, false, SHIPPIT),
    zone('nsw-regional', 'NSW Regional', 'NSW', 'regional', [[2000, 2999]], null, false),
    zone('nsw-remote', 'NSW Remote', 'NSW', 'remote', [], null, false),
    zone('vic-regional', 'VIC Regional', 'VIC', 'regional', [[3000, 3999], [8000, 8999]], null, false),
    zone('vic-remote', 'VIC Remote', 'VIC', 'remote', [], null, false),
    zone('qld-regional', 'QLD Regional', 'QLD', 'regional', [[4000, 4999], [9000, 9999]], null, false),
    zone('qld-remote', 'QLD Remote', 'QLD', 'remote', [], null, false),
    zone('sa-regional', 'SA Regional', 'SA', 'regional', [[5000, 5999]], null, false),
    zone('sa-remote', 'SA Remote', 'SA', 'remote', [], null, false),
    zone('wa-regional', 'WA Regional', 'WA', 'regional', [[6000, 6999]], null, false),
    zone('wa-remote', 'WA Remote', 'WA', 'remote', [], null, false),
    zone('tas', 'Tasmania', 'TAS', 'regional', [[7000, 7999]], null, false),
    zone('tas-remote', 'TAS Remote', 'TAS', 'remote', [], null, false),
    zone('nt', 'Northern Territory', 'NT', 'regional', [[800, 899]], null, false),
    zone('nt-remote', 'NT Remote', 'NT', 'remote', [], null, false),
  ],
  // postcode-specific overrides: { postcode: '2765', zone_id: 'syd-metro', note }
  postcode_overrides: [],

  // section 6 weights (kg/m² as g/m²) and thicknesses. Print media values are provisional estimates.
  materials: {
    corflute_3mm: { label: 'Corflute 3mm', thickness_mm: 3, g_m2: 450 },
    corflute_5mm: { label: 'Corflute 5mm', thickness_mm: 5, g_m2: 750 },
    foamboard_5mm: { label: 'Foamboard 5mm', thickness_mm: 5, g_m2: 650 },
    foamboard_10mm: { label: 'Foamboard 10mm', thickness_mm: 10, g_m2: 1000 },
    pvc_2mm: { label: 'Foam PVC 2mm', thickness_mm: 2, g_m2: 1100 },
    pvc_3mm: { label: 'Foam PVC 3mm', thickness_mm: 3, g_m2: 1650 },
    pvc_5mm: { label: 'Foam PVC 5mm', thickness_mm: 5, g_m2: 2750 },
    acm_3mm: { label: 'ACM 3mm', thickness_mm: 3, g_m2: 3800 },
    enviro_10mm: { label: 'EnviroBoard 10mm', thickness_mm: 10, g_m2: 1800 },
    enviro_20mm: { label: 'EnviroBoard 20mm', thickness_mm: 20, g_m2: 2800 },
    poster_paper: { label: 'Poster paper 220gsm', thickness_mm: 0.25, g_m2: 220, verify: true },
    synthetic_paper: { label: 'Satin synthetic paper', thickness_mm: 0.25, g_m2: 200, verify: true },
    window_short: { label: 'Window graphics, short term', thickness_mm: 0.2, g_m2: 220, verify: true },
    window_perm: { label: 'Window graphics, permanent', thickness_mm: 0.25, g_m2: 280, verify: true },
    floor_decal: { label: 'Floor decal with anti-slip laminate', thickness_mm: 0.35, g_m2: 450, verify: true },
    wallpaper_textured: { label: 'Textured canvas wallpaper', thickness_mm: 0.45, g_m2: 350, verify: true },
    wallpaper_smooth: { label: 'Smooth matte wallpaper', thickness_mm: 0.3, g_m2: 250, verify: true },
  },
  // How product options map to a material: every word in `match` must appear in the chosen options.
  material_rules: [
    { match: ['corflute', '3mm'], material: 'corflute_3mm' }, { match: ['corflute', '5mm'], material: 'corflute_5mm' },
    { match: ['foamboard', '10mm'], material: 'foamboard_10mm' }, { match: ['foamboard', '5mm'], material: 'foamboard_5mm' },
    { match: ['pvc', '2mm'], material: 'pvc_2mm' }, { match: ['pvc', '3mm'], material: 'pvc_3mm' }, { match: ['pvc', '5mm'], material: 'pvc_5mm' },
    { match: ['enviro', '10mm'], material: 'enviro_10mm' }, { match: ['enviro', '20mm'], material: 'enviro_20mm' },
    { match: ['aluminium composite'], material: 'acm_3mm' },
    { match: ['synthetic'], material: 'synthetic_paper' }, { match: ['poster paper'], material: 'poster_paper' },
    { match: ['window', 'permanent'], material: 'window_perm' }, { match: ['window', 'short'], material: 'window_short' },
    { match: ['floor decal'], material: 'floor_decal' },
    { match: ['textured canvas'], material: 'wallpaper_textured' }, { match: ['smooth matte'], material: 'wallpaper_smooth' },
  ],

  // section 10 packaging costs (per actual package) and packaging weights (provisional)
  packaging: {
    cardboard_cents_m2: 600, bubble_cents_m2: 65, labour_cents: 800, tape_cents: 150,
    waste_bps: 1000,                       // +10% on measured cardboard and bubble-wrap areas
    cardboard_g_m2: 550, bubble_g_m2: 40,  // packaging weight added to the packed weight
    verify: true,
  },

  // Packing profiles. Only items in the same profile (and group) are packed together.
  profiles: {
    rigid: {   // section 6
      label: 'Rigid signage', edge_allowance_mm: 20, height_allowance_mm: 28, min_height_mm: 30, max_height_mm: 150, max_weight_g: 20000,
      stacking: 'same_size',     // 'same_size' = only identical sizes share a stack; 'fit_within' = smaller boards may sit on a larger one
      mix_materials: true,       // may different rigid materials share a stack?
      cardboard: 'box', bubble: 'wrap', verify: true,
    },
    flat: {    // A4/A3 posters, shipped flat in a board sleeve
      label: 'Flat prints (A4/A3)', edge_allowance_mm: 20, height_allowance_mm: 28, min_height_mm: 30, max_height_mm: 150, max_weight_g: 20000,
      stacking: 'fit_within', mix_materials: true, cardboard: 'box', bubble: 'none', verify: true,
    },
    rolled: {  // section 7
      label: 'Rolled prints', core_mm: 80, max_printed_width_mm: 1350, max_packed_width_mm: 1400, max_diameter_mm: 200, max_weight_g: 20000,
      end_allowance_mm: 50, diameter_allowance_mm: 20, core_g_per_m: 250, mix_widths: true, oversize: 'unavailable',
      cardboard: 'tube', bubble: 'tube', verify: true,
    },
    wallpaper: {   // section 7, own profile: rolls in cartons
      label: 'Wallpaper', roll_area_m2: 10, rolls_per_carton: 4, waste_bps: 1000, max_weight_g: 20000,
      carton: { length_mm: 1100, width_mm: 250, height_mm: 250 }, cardboard: 'box', bubble: 'none', verify: true,
    },
    unit: {    // section 8 (A-frames) and items sent as fixed-size parcels
      label: 'Fixed-size parcels', max_weight_g: 20000, cardboard: 'box', bubble: 'none',
    },
    flatpack: {    // section 9
      label: 'Flat-packed boxes and cartons', edge_allowance_mm: 20, protection_mm: 40, max_stack_mm: 300, max_weight_g: 20000,
      cardboard: 'box', bubble: 'none', verify: true,
    },
  },

  // Fixed-size parcels: packed size and weight per unit, and how many units share one package.
  // A-frames are one per package (section 8). All provisional: please confirm with real items.
  units: {
    'aframe-metal-600x900': { label: 'Metal face A-frame 600 x 900', length_mm: 980, width_mm: 680, height_mm: 120, weight_g: 9000, per_package: 1, verify: true },
    'aframe-metal-900x1200': { label: 'Metal face A-frame 900 x 1200', length_mm: 1280, width_mm: 980, height_mm: 140, weight_g: 15000, per_package: 1, verify: true },
    'aframe-corflute-600x900': { label: 'Corflute insertable A-frame 600 x 900', length_mm: 980, width_mm: 680, height_mm: 100, weight_g: 6000, per_package: 1, verify: true },
    'aframe-corflute-900x1200': { label: 'Corflute insertable A-frame 900 x 1200', length_mm: 1280, width_mm: 980, height_mm: 120, weight_g: 10000, per_package: 1, verify: true },
    'pull-up-banner': { label: 'Pull up banner (standard, in carry bag)', length_mm: 900, width_mm: 150, height_mm: 150, weight_g: 4500, per_package: 1, verify: true },
    'pull-up-banner-premium': { label: 'Pull up banner (premium, in carry bag)', length_mm: 920, width_mm: 180, height_mm: 180, weight_g: 6500, per_package: 1, verify: true },
    'cake-topper': { label: 'Cake topper (padded mailer)', length_mm: 300, width_mm: 230, height_mm: 30, weight_g: 120, per_package: 5, verify: true },
    'wallpaper-sample': { label: 'Wallpaper sample (envelope)', length_mm: 250, width_mm: 180, height_mm: 10, weight_g: 50, per_package: 10, verify: true },
  },

  // Flat-pack boxes: board thickness and weight, and how the flat size is worked out.
  // 'rsc' (shipping cartons, folded flat):  flat = (L + W + 35) x (H + W), 2 layers of board
  // 'mailer' (die-cut mailers, supplied flat): flat = (2W + 3H + 40) x (L + 2H + 20), 1 layer
  flatpack: {
    boards: {
      'White E Flute 1.5mm': { thickness_mm: 1.5, g_m2: 400 },
      'White B Flute 3mm': { thickness_mm: 3, g_m2: 550 },
      'Kraft B Flute 3mm': { thickness_mm: 3, g_m2: 550 },
    },
    sizes: {},   // optional exact flat sizes: { '225 × 160 × 80': { length_mm, width_mm, weight_g } }
    verify: true,
  },

  // Which profile each product uses. Product settings win over category settings.
  catalogue: {
    categories: {
      corflute: { profile: 'rigid' }, 'acm-panels': { profile: 'rigid', material: 'acm_3mm' }, 'foam-pvc': { profile: 'rigid' },
      foamboard: { profile: 'rigid' }, enviroboard: { profile: 'rigid' },
      posters: { profile: 'poster' }, 'window-graphics': { profile: 'rolled' }, 'floor-decals': { profile: 'rolled', material: 'floor_decal' },
      wallpaper: { profile: 'wallpaper' },
      'mailer-boxes': { profile: 'flatpack', formula: 'mailer' }, 'shipping-cartons': { profile: 'flatpack', formula: 'rsc' },
      'pull-up-banners': { profile: 'unit', unit: 'pull-up-banner' }, 'cake-toppers': { profile: 'unit', unit: 'cake-topper' },
      'a-frames': { profile: 'unit' },
    },
    products: {
      'wallpaper-sample': { profile: 'unit', unit: 'wallpaper-sample' },
      'premium-pull-up-banner-stands': { profile: 'unit', unit: 'pull-up-banner-premium' },
      'double-sided-premium-pull-up-banner-stand': { profile: 'unit', unit: 'pull-up-banner-premium' },
      'metal-face-a-frame': { profile: 'unit', unit_by_size: { '600mmW x 900mmH': 'aframe-metal-600x900', '900mmW x 1200mmH': 'aframe-metal-900x1200' } },
      'corflute-insertable-a-frame': { profile: 'unit', unit_by_size: { '600mmW x 900mmH': 'aframe-corflute-600x900', '900mmW x 1200mmH': 'aframe-corflute-900x1200' } },
    },
  },
  // posters: these sizes ship flat; larger ones are rolled
  poster_flat_sizes: ['A4', 'A3'],
  paper_sizes: { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] },
};
