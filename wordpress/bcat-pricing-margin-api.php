<?php
/**
 * BCAT Pricing Margin — REST API Endpoint
 * 
 * Provides a WordPress REST API endpoint for reading/writing the margin config
 * used by the bcat-pricing-integration plugin on bestcareautotransport.com.
 * 
 * Endpoints:
 *   GET  /wp-json/bcat-pricing/v1/margin
 *   POST /wp-json/bcat-pricing/v1/margin
 * 
 * Stores config in WordPress option 'bcat_pricing_margin'.
 * The bcat-pricing-integration plugin should call get_option('bcat_pricing_margin')
 * to retrieve the current margin settings.
 * 
 * Installation:
 *   Upload this file to wp-content/mu-plugins/bcat-pricing-margin-api.php
 *   OR add via WPCode as a PHP snippet (run everywhere, priority 10)
 */

// Prevent direct access
if (!defined('ABSPATH')) {
    exit;
}

// ── Register REST API endpoints ───────────────────────────────────────────────

add_action('rest_api_init', function () {
    
    // GET current margin config
    register_rest_route('bcat-pricing/v1', '/margin', [
        'methods' => 'GET',
        'callback' => function () {
            $config = get_option('bcat_pricing_margin', [
                'percent' => 15,
                'flatAmount' => 0,
                'mode' => 'percent',  // 'percent', 'flat', or 'both'
                'updatedAt' => null,
            ]);
            
            return new WP_REST_Response($config, 200);
        },
        'permission_callback' => '__return_true',  // public read
    ]);
    
    // POST/update margin config (requires authentication)
    register_rest_route('bcat-pricing/v1', '/margin', [
        'methods' => 'POST',
        'callback' => function (WP_REST_Request $request) {
            $params = $request->get_json_params();
            
            $config = [
                'percent' => isset($params['percent']) ? floatval($params['percent']) : 15,
                'flatAmount' => isset($params['flatAmount']) ? floatval($params['flatAmount']) : 0,
                'mode' => isset($params['mode']) ? sanitize_text_field($params['mode']) : 'percent',
                'updatedAt' => current_time('c'),
            ];
            
            // Validate
            if ($config['percent'] < 0 || $config['percent'] > 100) {
                return new WP_REST_Response(['error' => 'Percent must be between 0 and 100'], 400);
            }
            if ($config['flatAmount'] < 0 || $config['flatAmount'] > 5000) {
                return new WP_REST_Response(['error' => 'Flat amount must be between 0 and 5000'], 400);
            }
            if (!in_array($config['mode'], ['percent', 'flat', 'both'])) {
                return new WP_REST_Response(['error' => 'Mode must be percent, flat, or both'], 400);
            }
            
            update_option('bcat_pricing_margin', $config);
            
            return new WP_REST_Response([
                'success' => true,
                'config' => $config,
            ], 200);
        },
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
    ]);
    
});

// ── Filter to inject margin into pricing calculations ──────────────────────────
// 
// USAGE: In bcat-pricing-integration.php, replace the hardcoded margin with:
//   $margin = get_option('bcat_pricing_margin', ['percent' => 15, 'flatAmount' => 0, 'mode' => 'percent']);
//   $carrierRate = $superDispatchResponse['rate'];  // from Super Dispatch API
//   
//   $marginAmount = 0;
//   if ($margin['mode'] === 'percent' || $margin['mode'] === 'both') {
//       $marginAmount += $carrierRate * ($margin['percent'] / 100);
//   }
//   if ($margin['mode'] === 'flat' || $margin['mode'] === 'both') {
//       $marginAmount += $margin['flatAmount'];
//   }
//   $customerPrice = $carrierRate + $marginAmount;
//
// The config page at bcat-ops (/pricing-margin) writes to this option via this
// REST API. Changes take effect immediately on the next quote calculation.

// ── Helper: expose margin to admin bar (debug) ──────────────────────────────────

add_action('admin_bar_menu', function ($admin_bar) {
    if (!current_user_can('manage_options')) return;
    
    $config = get_option('bcat_pricing_margin', []);
    $mode = $config['mode'] ?? 'percent';
    $pct = $config['percent'] ?? 15;
    $flat = $config['flatAmount'] ?? 0;
    
    $label = 'Margin: ';
    if ($mode === 'percent') $label .= "{$pct}%";
    elseif ($mode === 'flat') $label .= "\${$flat}";
    else $label .= "{$pct}% + \${$flat}";
    
    $admin_bar->add_menu([
        'id' => 'bcat-pricing-margin',
        'title' => $label,
        'href' => admin_url('options-general.php?page=bcat-pricing'),
        'meta' => ['title' => 'BCAT Pricing Margin'],
    ]);
}, 100);