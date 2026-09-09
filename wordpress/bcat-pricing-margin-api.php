<?php
/**
 * BCAT Pricing Margin — REST API Endpoint (v2)
 * 
 * Provides a WordPress REST API endpoint for reading the margin config
 * used by the bcat-pricing-integration plugin on bestcareautotransport.com.
 * 
 * Endpoints:
 *   GET  /wp-json/bcat-pricing/v1/margin   — public, returns current margin config
 *   POST /wp-json/bcat-pricing/v1/margin   — auth required, updates margin config
 * 
 * Storage: syncs between WP option 'bcat_pricing_margin' AND the page
 * 'bcat-pricing-margin-config' so the bcat-ops dashboard and the pricing
 * plugin always agree.
 * 
 * Installation:
 *   Upload this file to wp-content/mu-plugins/bcat-pricing-margin-api.php
 */

if (!defined('ABSPATH')) {
    exit;
}

// ── Read margin config (tries option first, falls back to page) ────────────
function bcat_get_margin_config(): array {
    // 1. Try the option (set by this API or the pricing plugin)
    $config = get_option('bcat_pricing_margin', null);
    if ($config && is_array($config)) {
        return $config;
    }

    // 2. Fall back to the config page (set by bcat-ops dashboard)
    $page = get_page_by_path('bcat-pricing-margin-config', OBJECT, 'page');
    if ($page) {
        $content = wp_strip_all_tags($page->post_content);
        $parsed = json_decode($content, true);
        if ($parsed && is_array($parsed)) {
            $defaults = ['percent' => 15, 'flatAmount' => 0, 'mode' => 'percent', 'updatedAt' => null];
            $config = array_merge($defaults, $parsed);
            // Sync to option so future reads are fast
            update_option('bcat_pricing_margin', $config);
            return $config;
        }
    }

    // 3. Default
    return [
        'percent' => 15,
        'flatAmount' => 0,
        'mode' => 'percent',
        'updatedAt' => null,
    ];
}

// ── Save margin config (updates both option AND page) ──────────────────────
function bcat_set_margin_config(array $data): array {
    $config = [
        'percent' => isset($data['percent']) ? floatval($data['percent']) : 15,
        'flatAmount' => isset($data['flatAmount']) ? floatval($data['flatAmount']) : 0,
        'mode' => isset($data['mode']) ? sanitize_text_field($data['mode']) : 'percent',
        'updatedAt' => isset($data['updatedAt']) 
            ? sanitize_text_field($data['updatedAt']) 
            : current_time('c'),
    ];

    // Validate
    if ($config['percent'] < 0 || $config['percent'] > 100) {
        return ['error' => 'Percent must be between 0 and 100'];
    }
    if ($config['flatAmount'] < 0 || $config['flatAmount'] > 5000) {
        return ['error' => 'Flat amount must be between 0 and 5000'];
    }
    if (!in_array($config['mode'], ['percent', 'flat', 'both'])) {
        return ['error' => 'Mode must be percent, flat, or both'];
    }

    // Save to option (fast path, read by get_option)
    update_option('bcat_pricing_margin', $config);

    // Sync to page (so bcat-ops dashboard sees it)
    $json = json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    $page = get_page_by_path('bcat-pricing-margin-config', OBJECT, 'page');
    
    if ($page) {
        wp_update_post([
            'ID' => $page->ID,
            'post_content' => $json,
        ]);
    } else {
        wp_insert_post([
            'post_title' => 'BCAT Pricing Margin Config',
            'post_name' => 'bcat-pricing-margin-config',
            'post_content' => $json,
            'post_status' => 'publish',
            'post_type' => 'page',
        ]);
    }

    return ['success' => true, 'config' => $config];
}

// ── Register REST API endpoints ───────────────────────────────────────────

add_action('rest_api_init', function () {
    
    // GET current margin config (public)
    register_rest_route('bcat-pricing/v1', '/margin', [
        'methods' => 'GET',
        'callback' => function () {
            return new WP_REST_Response(bcat_get_margin_config(), 200);
        },
        'permission_callback' => '__return_true',
    ]);
    
    // POST/update margin config (auth required)
    register_rest_route('bcat-pricing/v1', '/margin', [
        'methods' => 'POST',
        'callback' => function (WP_REST_Request $request) {
            $params = $request->get_json_params();
            $result = bcat_set_margin_config($params);
            
            if (isset($result['error'])) {
                return new WP_REST_Response($result, 400);
            }
            return new WP_REST_Response($result, 200);
        },
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
    ]);
});

// ── Helper: show margin in admin bar (debug) ───────────────────────────────

add_action('admin_bar_menu', function ($admin_bar) {
    if (!current_user_can('manage_options')) return;
    
    $config = bcat_get_margin_config();
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