"""Global, module-wise app integration guide.

Built from the Postman collection (step folders: descriptions, request bodies,
live example responses) and the release-step test report, plus the screen
requirements gathered from the app. Add a step to STEPS when it is released.
"""
import glob, json, re
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import CondPageBreak, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, XPreformatted

ROOT = r"C:\officeProjects\mealJiBackend"
OUT = ROOT + r"\MealJi_App_Integration_Guide.pdf"
collection = json.load(open(ROOT + r"\mealJiNode\postman\mealJiNode.postman_collection.json", encoding="utf-8"))
# Newest result per step across all reports in test-reports/.
_latest = {}
for _run in sorted((json.load(open(f, encoding="utf-8")) for f in glob.glob(ROOT + r"\mealJiNode\test-reports\steps-*.json")), key=lambda r: r["runAt"]):
    for _step in _run["steps"]:
        _latest[_step["step"]] = {**_step, "runAt": _run["runAt"]}
report = {"runAt": max(r["runAt"] for r in _latest.values()), "steps": list(_latest.values())}
DATE = "9 Oct 2026"

pdfmetrics.registerFont(TTFont("Segoe", r"C:\Windows\Fonts\segoeui.ttf"))
pdfmetrics.registerFont(TTFont("SegoeB", r"C:\Windows\Fonts\segoeuib.ttf"))
pdfmetrics.registerFont(TTFont("Mono", r"C:\Windows\Fonts\consola.ttf"))
pdfmetrics.registerFontFamily("Segoe", normal="Segoe", bold="SegoeB", italic="Segoe", boldItalic="SegoeB")

INK, MUTED, BRAND = colors.HexColor("#1B1B23"), colors.HexColor("#5B5B6B"), colors.HexColor("#2C40A6")
LINE, SOFT = colors.HexColor("#DADCE6"), colors.HexColor("#F3F4F9")
OK, WARN, BAD = colors.HexColor("#1E7B4F"), colors.HexColor("#A15C00"), colors.HexColor("#B42318")
TITLE = ParagraphStyle("T", fontName="SegoeB", fontSize=22, leading=28, textColor=BRAND, spaceAfter=6)
H1 = ParagraphStyle("H1", fontName="SegoeB", fontSize=16, leading=21, textColor=INK, spaceBefore=2, spaceAfter=6)
H2 = ParagraphStyle("H2", fontName="SegoeB", fontSize=11.5, leading=15, textColor=BRAND, spaceBefore=9, spaceAfter=4)
H3 = ParagraphStyle("H3", fontName="SegoeB", fontSize=10, leading=13.5, textColor=INK, spaceBefore=8, spaceAfter=3)
BODY = ParagraphStyle("Body", fontName="Segoe", fontSize=9.2, leading=13, textColor=INK, spaceAfter=4)
SMALL = ParagraphStyle("Small", fontName="Segoe", fontSize=8.2, leading=11.2, textColor=MUTED, spaceAfter=3)
CELL = ParagraphStyle("Cell", fontName="Segoe", fontSize=8.3, leading=11.2, textColor=INK)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="SegoeB")
HEAD = ParagraphStyle("Head", parent=CELL, fontName="SegoeB", textColor=colors.white)
BUL = ParagraphStyle("Bul", parent=BODY, leftIndent=12, bulletIndent=2, spaceAfter=2)
CODE = ParagraphStyle("Code", fontName="Mono", fontSize=7.2, leading=9.3, textColor=INK, backColor=colors.HexColor("#F6F7FB"), borderColor=LINE, borderWidth=0.4, borderPadding=(5, 6, 5, 6), leftIndent=6, rightIndent=6, spaceBefore=5, spaceAfter=8)
W = A4[0] - 36 * mm


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(text):
    """Markdown-ish → reportlab markup: `code` and **bold**."""
    text = esc(text)
    text = re.sub(r"`([^`]+)`", lambda m: f'<font face="Mono" size="8">{m.group(1)}</font>', text)
    return re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)


def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items):
    return [Paragraph(inline(i), BUL, bulletText="•") for i in items]


def markdown(text):
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [line for line in block.split("\n") if line.strip()]
        if all(line.lstrip().startswith("- ") for line in lines):
            out += bullets([line.lstrip()[2:] for line in lines])
        else:
            for line in lines:
                if line.lstrip().startswith("- "):
                    out += bullets([line.lstrip()[2:]])
                else:
                    out.append(p(inline(line)))
    return out


def table(rows, widths, bold_first=True, styles=None):
    data = [[Paragraph(x, HEAD) for x in rows[0]]] + [[x if not isinstance(x, str) else Paragraph(x, CELLB if (i == 0 and bold_first) else CELL) for i, x in enumerate(r)] for r in rows[1:]]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), BRAND), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, SOFT]),
                           ("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("TOPPADDING", (0, 0), (-1, -1), 3.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.2),
                           ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)] + (styles or [])))
    return t


def shorten(value):
    if isinstance(value, dict):
        return {k: shorten(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shorten(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r"https://d3bi5d5em13bi2\.cloudfront\.net/mealji/", "https://cdn…/mealji/", value)
        if re.fullmatch(r"[0-9a-f]{24}", value):
            return value[:6] + "…"
        if value.startswith("eyJ") and len(value) > 30:
            return value[:16] + "…"
        if len(value) > 74:
            return value[:71] + "…"
    return value


def codeblock(obj, max_lines=None):
    text = obj if isinstance(obj, str) else json.dumps(shorten(obj), indent=2, ensure_ascii=False)
    lines = text.split("\n")
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines] + ["  …"]
    return XPreformatted(esc("\n".join(lines)), CODE)


def path_of(request):
    url = request["url"] if isinstance(request["url"], str) else request["url"].get("raw", "")
    return url.replace("{{baseUrl}}/api/v1", "")


def is_public(item):
    desc = item["request"].get("description") or ""
    return desc.startswith("Public")


# Screen requirements gathered from the customer app (read-only scan) per step.
APP_NEEDS = {
    "01": {
        "screens": "Splash, Onboarding",
        "needs": [
            "Splash: decide where to go on launch — force update / maintenance first, then a saved session (go to Home) or Onboarding / Login.",
            "Onboarding has 3 custom-drawn steps, not plain image slides: a chef mascot step, a 6-photo menu grid (Signature Bowls, Steamed Bao, Global Wraps, Street Snacks, Comfort Curries, Desserts) and a fresh step with a benefit strip (Hot Meals, Real Ingredients, Happier You).",
            "Each title has words drawn in the accent colour (“Meal Ji.”, “hero.”, “Delivered warm.”) and its own button text (“Show me the menu”, “Continue”, “Let's eat”).",
            "The copy uses the delivery promise (“25–35 minutes”, “pick it up in 15”), which now comes from App config.",
        ],
        "flow": [
            "On launch: `GET /app/config`. If `forceUpdate` (or the app version is below `minSupportedVersion`) show the update screen; if `maintenanceMode` show `maintenanceMessage`.",
            "If tokens are stored: `GET /auth/me` (step 2). 200 → Home; 401 → refresh, then Login.",
            "First open only: `GET /onboarding/slides` and draw each slide by its `layout`. Cache the response; it changes rarely.",
            "Keep the bundled images as a fallback so onboarding still works offline.",
        ],
    },
    "02": {
        "screens": "Login, OTP",
        "needs": [
            "Login: one phone box with the +91 prefix. The placeholder says “Phone number or email” but sign-in is by mobile OTP only — an email now gets a clear message.",
            "OTP: 6 boxes, a 30-second resend countdown, a “wrong OTP” message.",
            "After OTP a new customer goes to Profile setup; a returning one skips it (and skips Location when it is already saved).",
            "The app's user model shows name, phone, points, tier and avatar.",
        ],
        "flow": [
            "Generate one `x-device-id` per install (e.g. a UUID kept in secure storage) and send it on every call.",
            "`POST /auth/login` → keep `userId`, start the timer from `resendAfterSec`, size the boxes from `otpLength`.",
            "`POST /auth/verify-otp` → store `accessToken` + `refreshToken` securely. Route on `profileComplete` and `user.currentLocation`.",
            "Send `Authorization: Bearer <accessToken>`. On 401: `POST /auth/refresh` once, retry the call; if refresh is 401, clear tokens and show Login.",
            "Profile → Log out: `POST /auth/logout`, then clear tokens.",
        ],
    },
    "03": {
        "screens": "Profile setup, Edit profile",
        "needs": [
            "Profile setup: “Complete Profile” with full name (min 2 characters) and optional email, then Continue.",
            "Edit profile: name, phone (read-only), email, date of birth, gender (“Male”, “Female”, “Other”, “Prefer not to say”), change photo.",
            "Profile header: name, photo, points, tier and counts (orders, favourites, addresses, payment methods).",
        ],
        "flow": [
            "Profile setup → `PATCH /users/me` with `name` (and `email`). The response has `profileComplete: true`; continue to Location.",
            "Edit profile loads `GET /users/me`, saves with `PATCH /users/me` (only changed fields). Show `errors[].message` under the matching field.",
            "Photo: `POST /uploads/presign` → PUT the file bytes to `uploadUrl` with the returned `headers` → `POST /users/me/avatar` with `fileUrl`.",
        ],
    },
    "04": {
        "screens": "Location, Addresses, Add new address, Update address",
        "needs": [
            "Location: “Use current location”, a search box, and a “we don't deliver here yet” state.",
            "Addresses: cards labelled Home / Office / Other or a custom name (e.g. “Parents' Home”), one default, Edit and Delete.",
            "Add new address form: Full name, Phone, Pincode, House/Flat, Landmark, City, State and the Home / Office / Other chips — no map pin.",
            "Update address: the same form, pre-filled.",
        ],
        "flow": [
            "“Use current location”: get the GPS point, `PUT /users/me/location`; read `data.serviceability.serviceable`. Yes → Home. No → show `serviceability.message` and let the user search or pick an address.",
            "Search: `GET /geo/autocomplete?input=…&sessionToken=…` while typing (debounce 300 ms) → `GET /geo/place/{placeId}` on tap → `PUT /users/me/location` with its point.",
            "Addresses screen: `GET /users/me/addresses`. Print `displayLabel` and `fullAddress`; grey out cards with `serviceable: false`.",
            "Add address: `POST /users/me/addresses` with the form fields and the chip text as `label`. Send `latitude`/`longitude` only if the user pinned a map.",
            "Edit: `PATCH /users/me/addresses/{addressId}`. Choose for delivery: `PATCH …/{addressId}/default`. Delete: `DELETE …/{addressId}`.",
        ],
    },
    "05": {
        "screens": "Home, About chef",
        "needs": [
            "Header: seasonal gradient with two promo images (e.g. Halloween), “Deliver to” pill, bell with unread count, greeting with the first name, “What are you craving today?”, Veg / All switch, search box hint, filter button.",
            "Sections in this order: signature hero carousel (eyebrow, title with an accent word, subtitle, Order Now), Today's Menu tiles + See all, MEAL COMBOS card, three feature icons, Your usual? (Reorder), Meal Ji Plus plans with monthly price and what you get, How we cook, Popular today.",
            "Floating bar: “Unlock Free delivery · Shop for ₹99 more” and the cart count.",
            "Filters sheet: Pure Veg / Fast Delivery / Top Rated chips, five sort options, cuisines (several can be picked), Clear All / Apply Filters.",
            "About chef: hero photo with a “FOUNDED 2024 • GREATER NOIDA” tag, “THE MAN BEHIND THE FLAME”, the chef's quote and name, two story paragraphs, “The Meal Ji Standard” with three icon points, and a “Taste the Menu” button.",
        ],
        "flow": [
            "Open Home: `GET /home` (add `veg=true` when the Veg switch is on). Draw `header` (or the default header when null), then `sections` in the order received, by `type`. Pull-to-refresh calls it again.",
            "When `serviceability.serviceable` is false, show `serviceability.message` and a Change location button (step 4).",
            "Filters: `GET /dishes/filters` once to build the sheet; Apply → `GET /dishes?quick=…&sort=…&cuisine=…` and show the result list.",
            "Banners: report `impression` when shown and `click` when tapped (`POST /banners/{id}/{event}`); open `deepLink`.",
            "Also `GET /in-app-messages?screen=home` and show any message once (report shown / clicked / dismissed).",
            "How we cook (`mealji://about-chef`) → About chef: `GET /kitchen-about`. “Taste the Menu” opens `ctaDeepLink`.",
            "Taps on a dish, combo, See all, Cart or Plus open screens from later steps (6, 8, 14).",
        ],
    },
    "06": {
        "screens": "Menu, Dish detail, Combos",
        "needs": [
            "Menu: category tabs (name, icon/photo, tagline such as “Aromatic. Authentic. Always a good idea.”), a grid of dish cards (photo, Bestseller badge, heart, name, 2-line description, price, Add +), the MEAL COMBOS banner and a search box.",
            "Dish detail: feature badges (Fresh Ingredients / Slow Cooked / Halal Certified), MOST POPULAR label, name, price, ★ rating with review count, minutes, Serves, description, “Select a portion” cards (Regular · Serves 1 / Large · Serves 2 / Family Pack · Serves 3-4), option groups, “Make it a meal” (components, ~~₹417~~ ₹349, Save ₹68), “From the chef” card, “You may also like”, quantity and Add to cart.",
            "Combos: “Curated by the chef”, chips All / For one / For two / Family / Under ₹500, cards with title, items, price, struck original price, “Save ₹X”, badge and Add.",
            "States the app has images for: sold out and kitchen closed.",
        ],
        "flow": [
            "Menu tab: `GET /menu` (or the app's own path `GET /kitchens/{kitchenId}/menu`). Draw `categories` as tabs and each category's `dishes` as the grid. `kitchen.isOpenNow` false → show `kitchen.closedMessage` and disable Add.",
            "A dish with `isAvailable: false` shows `unavailableMessage` (e.g. “Sold out for today”, “Available for Breakfast (7–11 am)”) instead of Add.",
            "Dish card → `GET /menu/items/{dishId}`; then `GET /menu/items/{dishId}/recommendations` for “You may also like”. Use `portions`, `customizationGroups` (`required`, `multiple`, `minSelect`, `maxSelect`, option `pricePaise`) and `mealUpgrade` to build the choices; price = portion (or dish) price + chosen options + meal upgrade.",
            "Heart: `POST /users/me/favorites` / `DELETE /users/me/favorites/{dishId}` (step 7); every dish in these lists carries `isFavorite`.",
            "Combos: `GET /combos/filters` for the chips, `GET /combos?chip=…` for the list, `GET /combos/{comboId}` for one combo.",
            "Add to cart and the cart badge belong to step 8.",
        ],
    },
    "07": {
        "screens": "Search, Favourites",
        "needs": [
            "Search, empty: “Trending searches” chips and “Recent” rows.",
            "Search, results: “N dishes match \"query\"” and cards with badge or veg mark, name, price, description, photo, Add +.",
            "Search, nothing found: “No results found”, “Try these instead” chips and “Popular right now” cards with hearts.",
            "Favourites: the user's saved dishes (or the empty state “No favorites yet”), “Popular Picks for You”, the count on the Profile tile, and hearts on every dish card.",
        ],
        "flow": [
            "Open Search: `GET /search/trending` and `GET /search/recent`. Tap ✕ on a recent row → `DELETE /search/recent/{query}`; clear all → `DELETE /search/recent`.",
            "Typing: debounce ~300 ms, then `GET /search?q=…` (add `veg=true` when the Veg switch is on). Small typos still match. The server keeps one recent entry per typed word, not every letter.",
            "Show `dishCount` and `dishes` (also `combos`, `categories`). When `total` is 0, show `suggestions` as “Try these instead” and `popular` as “Popular right now”.",
            "Tap a result → `POST /search/{searchId}/click` with the `dishId`, then open Dish detail.",
            "Heart: `POST /users/me/favorites` (201 first time, 200 if already saved) and `DELETE /users/me/favorites/{dishId}`.",
            "Favourites screen: `GET /users/me/favorites`, newest first. `orderableHere` false → the dish is from a kitchen that does not deliver to the current location (or not available now): show it greyed with `kitchenName`. Empty → show the empty state and `GET /menu/popular` as Popular Picks.",
            "The Profile tile count is `stats.favorites` from `GET /users/me`.",
        ],
    },
}
STEPS = ["01", "02", "03", "04", "05", "06", "07"]

folders = {f["name"][5:7]: f for f in collection["item"] if re.match(r"^Step \d\d ", f["name"])}
results = {s["step"]: s for s in report["steps"]}


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Segoe", 7.5); canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 10 * mm, f"Meal Ji · App integration guide · steps {STEPS[0]}–{STEPS[-1]} · {DATE}")
    canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {doc.page}")
    canvas.setStrokeColor(LINE); canvas.line(18 * mm, 13 * mm, A4[0] - 18 * mm, 13 * mm)
    canvas.restoreState()


s = []
# ------------------------------------------------------------ cover / overview
s += [p("Meal Ji app integration guide", TITLE),
      p("Module by module, in the order the app developer integrates them. Each step lists what the app screens need, the call flow, every API with a request and a real response, the errors to handle, and the backend test results for that step.", BODY),
      p(f"API v1 · released steps {', '.join(STEPS)} · {DATE}. New steps are added to this guide as they are released.", SMALL)]

all_cases = [c for st in STEPS for c in results[st]["cases"]]
passed = sum(1 for c in all_cases if c["ok"])
s += [p("Release steps", H2)]
rows = [["Step", "Module", "Screens", "APIs", "Tests"]]
for st in STEPS:
    folder = folders[st]
    r = results[st]
    rows.append([st, esc(folder["name"].split(" · ", 1)[1]), esc(APP_NEEDS[st]["screens"]), str(len(folder["item"])), f'{r["passed"]}/{r["total"]} passed'])
s += [table(rows, [12 * mm, 40 * mm, 72 * mm, 14 * mm, W - 138 * mm]), Spacer(1, 4),
      p(f"Backend tests for these steps: <b>{passed}/{len(all_cases)} passed</b> (run {report['runAt'][:16].replace('T', ' ')} UTC against the API with demo data).", SMALL)]

s += [p("Basics for every call", H2)]
s += [table([
    ["Item", "Value"],
    ["Base URL", "Local: " + inline("`http://<server>:4000/api/v1`") + ". Staging/production URLs are shared separately."],
    ["Headers", inline("`Content-Type: application/json`, `x-device-id: <one id per install>`, and after sign-in `Authorization: Bearer <accessToken>`.")],
    ["Success", inline('`{ "success": true, "message": "…", "data": … }` — read `data`.')],
    ["Error", inline('`{ "success": false, "message": "…", "errors": [{ "field", "message" }] }` — show `message`; with `errors`, show each under its field.')],
    ["Status codes", inline("`400` bad request · `401` signed out (refresh, then Login) · `404` not found / not yours · `409` conflict · `422` form errors · `429` too many tries (wait) · `5xx` try again later.")],
    ["Tokens", "Access token ~15 min; refresh token keeps the user signed in for 60 days. Store both in secure storage."],
    ["Images", "All image fields are full CDN URLs (CloudFront). Use them as they are; keep bundled images as a fallback."],
    ["Demo data", inline("Customers `9000000031`–`9000000040`; OTP `123456` on the local/dev server. They never receive a real SMS.")],
], [28 * mm, W - 28 * mm])]

s += [p("Postman", H2),
      p(inline("Import `mealJiNode/postman/mealJiNode.postman_collection.json` and the local environment. Folders “Step 01 · App start” … are in this guide's order; each request has a description and saved example responses (success and errors). Login + Verify OTP store the tokens automatically."), BODY)]

# ------------------------------------------------------------ steps
for st in STEPS:
    folder = folders[st]
    need = APP_NEEDS[st]
    s += [PageBreak(), p(f"Step {st} · {esc(folder['name'].split(' · ', 1)[1])}", H1),
          p(f"Screens: <b>{esc(need['screens'])}</b>", BODY)]
    s += [p("What the app screens need", H2)] + bullets(need["needs"])
    s += [p("Call flow", H2)] + bullets(need["flow"])

    rows = [["#", "API", "Auth", "Used for"]]
    for item in folder["item"]:
        num, title = item["name"].split(" · ", 1)
        req = item["request"]
        rows.append([num, inline(f"`{req['method']} {path_of(req)}`"), "Public" if is_public(item) else "Token", esc(title)])
    s += [p("APIs in this step", H2), table(rows, [15 * mm, 78 * mm, 14 * mm, W - 107 * mm])]

    for item in folder["item"]:
        req = item["request"]
        num, title = item["name"].split(" · ", 1)
        head = [CondPageBreak(60 * mm), p(f"{num} · {esc(title)}", H3), p(inline(f"`{req['method']} /api/v1{path_of(req)}`"), BODY)]
        body = []
        body += markdown(req.get("description") or "")
        raw = (req.get("body") or {}).get("raw")
        if raw and raw.strip() not in ("{}", ""):
            body += [p("Request body", SMALL), codeblock(raw)]
        examples = item.get("response") or []
        good = [e for e in examples if e.get("code", 200) < 400]
        bad = [e for e in examples if e.get("code", 200) >= 400]
        for e in good[:2]:
            try:
                data = json.loads(e["body"])
            except Exception:
                continue
            body += [p(f"Response · {esc(e['name'])} ({e['code']})", SMALL), codeblock(data, max_lines=46)]
        if bad:
            rows = [["Case", "Status", "Message shown to the user"]]
            for e in bad:
                try:
                    msg = json.loads(e["body"]).get("message", "")
                    errs = json.loads(e["body"]).get("errors") or []
                except Exception:
                    msg, errs = "", []
                fields = ", ".join(sorted({x.get("field") for x in errs if x.get("field")}))
                rows.append([esc(e["name"]), str(e["code"]), esc(msg) + (f" <font color='#5B5B6B'>(field: {esc(fields)})</font>" if fields else "")])
            body += [p("Errors to handle", SMALL), table(rows, [48 * mm, 14 * mm, W - 62 * mm])]
        s += [KeepTogether(head + body[:2])] + body[2:]

    # test results
    r = results[st]
    rows = [["Test", "What the app needs", "Result"]]
    style = []
    for i, c in enumerate(r["cases"], start=1):
        status = "Warning" if c.get("warning") else ("Pass" if c["ok"] else "Fail")
        colour = WARN if c.get("warning") else (OK if c["ok"] else BAD)
        style.append(("TEXTCOLOR", (2, i), (2, i), colour))
        note = f"<br/><font color='#A15C00' size='7.5'>{esc(c['warning'])}</font>" if c.get("warning") else ""
        rows.append([c["id"], f"<b>{esc(c['name'])}</b><br/><font color='#5B5B6B' size='7.5'>{esc(c['requirement'])}</font>{note}", f"<font color='{colour.hexval().replace('0x', '#')}'><b>{status}</b></font>"])
    s += [CondPageBreak(50 * mm), p(f"Backend tests · {r['passed']}/{r['total']} passed", H2), table(rows, [15 * mm, W - 33 * mm, 18 * mm])]

# ------------------------------------------------------------ load and scale
s += [PageBreak(), p("Load and scale testing (steps 01–07)", H1),
      p("Two questions: do the APIs stay fast with a lot of data, and with many people using the app at once? Tests run on a separate database (<font face='Mono' size='8'>mealji_load</font>) so the demo data is never touched; SMS, Google Maps and S3 are switched off for these runs.", BODY)]
s += [p("Large data", H2), table([
    ["Data", "Amount"],
    ["Customers (each with a saved location)", "50,021"],
    ["Addresses / favourites", "100,000 / 250,000"],
    ["Orders (history) / notifications", "200,000 / 500,000"],
    ["Search history", "500,000"],
    ["Dishes per kitchen menu", "200"],
], [90 * mm, W - 90 * mm])]
try:
    idx = json.load(open(ROOT + r"\mealJiNode\test-reports\load-indexes.json", encoding="utf-8"))
    rows = [["Query behind the API", "Time", "Read → returned", "Result"]]
    for row in idx["rows"]:
        rows.append([esc(row["name"]), f"{row['ms']} ms", f"{row['examined']:,} → {row['returned']:,}", "OK" if row["ok"] else "Fix"])
    s += [p("Every query uses an index", H3), p("MongoDB's query plans on the large data: each query reads about as many records as it returns. The only wide read is “trending searches” (all searches of the last 7 days); it is cached for 10 minutes and now computed once at a time.", SMALL),
          table(rows, [78 * mm, 18 * mm, 40 * mm, W - 136 * mm])]
except FileNotFoundError:
    pass
s += [p("Many users at once", H2),
      p("A load runner signs in many customers and sends them through the step 01–07 screens with realistic weights (Home and Menu most often). Each virtual user makes calls back to back, so 25 concurrent ≈ 600–800 people actively using the app.", BODY),
      p("Database round trips per request (lower is faster)", H3), table([
          ["API", "Before", "After"],
          ["GET /home", "14.3", "9.1"],
          ["GET /menu", "6.9", "2"],
          ["GET /menu/items/{id}", "8", "2"],
          ["GET /search", "8", "4"],
          ["GET /users/me/favorites", "13", "5"],
          ["GET /users/me", "10", "7"],
          ["GET /users/me/preferences", "11", "4"],
          ["Every signed-in call (sign-in check)", "2–8", "1"],
      ], [90 * mm, 30 * mm, W - 120 * mm]),
      p("Same laptop, same 10 concurrent users: 44 → 129 requests/s, p95 569 → 161 ms (about 3× more capacity per server process).", SMALL)]
s += [p("What was changed for scale", H3)] + bullets([
    "The sign-in check ran once per router (up to 4 times per request); now once, with roles and permissions cached for 30 s.",
    "The serving kitchen, active kitchen list, app config, live Meal Ji Plus plans and resolved settings are kept in memory for a few seconds (cleared immediately on changes), instead of being read from MongoDB/Redis on every request.",
    "Parsed menus are kept in memory for 10 s; menu edits clear them.",
    "Place names for a saved location are cached per point (~10 m) for 30 days: far fewer paid Google calls.",
    "Profile counts are only computed for the profile; preferences no longer load them.",
    "One API process uses one CPU core (about 140 requests/s on the test laptop). `npm run start:cluster` runs one process per core; background jobs run once in `npm run worker`. Live updates go through Redis, so this needs no sticky sessions.",
])
s += [p("Limits of these numbers", H3)] + bullets([
    "Measured on a shared developer laptop: MongoDB and Redis there are slow (2–3.5 ms per call; Redis runs through Docker) and other projects were using the same CPU, so the absolute numbers are low and varied between runs. With 8 processes the laptop reached 170–200 requests/s; latency targets (p95 under 300 ms for reads) were met at 10–25 concurrent users.",
    "Before launch, repeat `npm run load:run` on a staging server sized like production (MongoDB replica set, Redis close to the API) to set the real capacity and the number of API processes.",
])

# ------------------------------------------------------------ changes
s += [PageBreak(), p("What changed in the backend for these steps", H1)]
s += bullets([
    "App config adds `otpLength`, `otpResendSeconds` (now 30 s, matching the OTP screen), `countryCodes`, `deliveryEtaLabel`, `pickupReadyMinutes`, `servedCitiesCount`.",
    "Onboarding slides carry `layout`, `highlight`, `ctaLabel` and `items` so the app's custom steps are admin-managed (Content → Onboarding in the admin console).",
    "Login accepts “+91 90000 00031”, spaces or a leading 0; an email gets a clear “mobile number only” message.",
    "The signed-in user and `/users/me` include `points`, `tier` and `avatarUrl`.",
    "Protected paths can no longer be reached by changing letter case (e.g. `/USERS/ME`).",
    "Profile: name needs 2+ characters; gender accepts the app's wording (“Male”, “Prefer not to say”).",
    "Place search and place details now use Google's Places API (New), which the server key supports; the old Places API was blocked for the key.",
    "Home adds `headline` and `searchPlaceholder` (admin-editable in Settings → App).",
    "Filters: `GET /dishes/filters` returns the app's quick chips and sort labels; `GET /dishes` accepts `quick=veg,fast,top_rated`, `sort=prep_time`, `relevance`, … and several cuisines (`cuisine=North Indian,Fusion`).",
    "About chef adds `tagline`, `quote`, `paragraphs`, `standardTitle`, `pillars`, `ctaLabel`, `ctaDeepLink` (admin: Content → About the chef).",
    "Images in CMS content must come from Meal Ji uploads (or the demo images) in every environment; images from other sites are refused.",
    "Menu / dish / combos: dishes of hidden categories disappear everywhere; dishes say why they cannot be ordered (`unavailableReason`, `unavailableMessage`, including breakfast/lunch/snacks/dinner hours); option groups say `required`/`multiple`; portions carry `serves`; “Make it a meal” has image, original price and saving; dish detail has `chef`, `isFavorite` and the kitchen's open state; combos carry item photos and prices, `savingsPaise`, `audience` and chips; `GET /combos/{id}` and the app's `GET /kitchens/{id}/menu` were added; every filter value is validated (422).",
    "Search / favourites: typo-tolerant search (“briyani”), suggestions and popular dishes for zero results, recent searches no longer store every typed letter, remove one recent search, search near a chosen point; favourites only for live dishes, 201/200 on repeat, `orderableHere` and `kitchenName`; profile `stats` (orders, favourites, addresses).",
    "Sign-in tokens are now pinned to HS256 and verified with a cached key.",
    "Addresses: `label` accepts Home / Office / Other or any custom text; responses add `displayLabel`. `latitude`/`longitude` are optional — the server places the address from its text or pincode, and refuses an address it cannot find with a 422 on `pincode`.",
])
doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                        title="Meal Ji app integration guide", author="Meal Ji backend")
doc.build(s, onFirstPage=footer, onLaterPages=footer)
print("wrote", OUT)
