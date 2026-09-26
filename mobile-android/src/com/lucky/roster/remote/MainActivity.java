package com.lucky.roster.remote;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Roster 远程的安卓外壳：界面来自电脑上的 Roster（手机远程页），这里只做三件事——
 * 记住电脑地址、全屏打开它、接住电脑面板二维码的链接。
 *
 * 明文 HTTP 只放行局域网 / Tailscale 地址；其他网址一律交给系统浏览器，
 * 不让这个壳变成能随便加载公网明文页面的浏览器。
 */
public class MainActivity extends Activity {
    private static final String CONNECT_PAGE = "file:///android_asset/connect.html";
    private static final String PREFS = "roster-remote";
    private static final String KEY_BASE = "base";
    private static final int DEFAULT_PORT = 8787;

    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        paintSystemBars();

        web = new WebView(this);
        web.setBackgroundColor(isNight() ? 0xFF0F1320 : 0xFFF4F6FA);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(false);
        // 本地只需要 android_asset（不受这两项影响），不给网页读手机文件的口子。
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "RosterApp");
        web.setWebViewClient(new Client());
        setContentView(web);

        if (savedState != null && web.restoreState(savedState) != null) return;
        if (openFromIntent(getIntent())) return;
        String base = prefs.getString(KEY_BASE, "");
        if (!base.isEmpty() && isAllowed(Uri.parse(base))) web.loadUrl(base + "/");
        else web.loadUrl(CONNECT_PAGE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromIntent(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("RosterApp");
            web.destroy();
        }
        super.onDestroy();
    }

    /** 电脑面板的二维码是 http://局域网地址:8787/?k=PIN：扫码时选本应用即直接连上。 */
    private boolean openFromIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
        Uri data = intent.getData();
        if (data == null || !isAllowed(data)) return false;
        remember(baseOf(data));
        web.loadUrl(data.toString());
        return true;
    }

    private void remember(String base) {
        prefs.edit().putString(KEY_BASE, base).apply();
    }

    private static String baseOf(Uri uri) {
        int port = uri.getPort() > 0 ? uri.getPort() : DEFAULT_PORT;
        return uri.getScheme() + "://" + uri.getHost() + ":" + port;
    }

    /** 用户手输的地址：可以只写 IP，也可以带端口或 http://。 */
    private static String normalize(String address) {
        String raw = address == null ? "" : address.trim();
        if (raw.isEmpty()) return null;
        if (!raw.contains("://")) raw = "http://" + raw;
        Uri uri = Uri.parse(raw);
        if (!isAllowed(uri)) return null;
        return baseOf(uri);
    }

    /** 只放行局域网 / Tailscale / 本机地址，以及常见的内网主机名后缀。 */
    static boolean isAllowed(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (host == null || !("http".equals(scheme) || "https".equals(scheme))) return false;
        host = host.toLowerCase();
        if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")
                || host.endsWith(".ts.net")) {
            return true;
        }
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                octets[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException error) {
                return false;
            }
            if (octets[i] < 0 || octets[i] > 255) return false;
        }
        int a = octets[0];
        int b = octets[1];
        return a == 10
                || a == 127
                || (a == 172 && b >= 16 && b <= 31)
                || (a == 192 && b == 168)
                || (a == 169 && b == 254)
                || (a == 100 && b >= 64 && b <= 127);
    }

    private boolean isNight() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    @SuppressWarnings("deprecation")
    private void paintSystemBars() {
        boolean night = isNight();
        int color = night ? 0xFF0F1320 : 0xFFF4F6FA;
        Window window = getWindow();
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        View decor = window.getDecorView();
        decor.setSystemUiVisibility(night ? 0
                : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url.toString().startsWith("file:///android_asset/") || isAllowed(url)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
                // 没有能打开的应用就算了，不在壳里加载外部页面。
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || !isAllowed(request.getUrl())) return;
            String base = baseOf(request.getUrl());
            view.loadUrl(CONNECT_PAGE + "?error=" + Uri.encode(String.valueOf(error.getDescription()))
                    + "&base=" + Uri.encode(base));
        }
    }

    /** 连接页（本地）与手机远程页都能调用；只收地址和 PIN，不暴露任何手机能力。 */
    private final class Bridge {
        @JavascriptInterface
        public String saved() {
            JSONObject result = new JSONObject();
            try {
                result.put("base", prefs.getString(KEY_BASE, ""));
            } catch (JSONException ignored) {
                // 空对象也能用
            }
            return result.toString();
        }

        @JavascriptInterface
        public boolean open(String address, String pin) {
            final String base = normalize(address);
            if (base == null) return false;
            remember(base);
            String code = pin == null ? "" : pin.trim();
            final String url = base + "/" + (code.isEmpty() ? "" : "?k=" + Uri.encode(code));
            runOnUiThread(() -> web.loadUrl(url));
            return true;
        }

        @JavascriptInterface
        public void openConnect() {
            runOnUiThread(() -> web.loadUrl(CONNECT_PAGE));
        }

        @JavascriptInterface
        public void forget() {
            prefs.edit().remove(KEY_BASE).apply();
        }
    }
}
