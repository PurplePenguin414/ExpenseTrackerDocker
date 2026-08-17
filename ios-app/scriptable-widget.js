// Side Job Tracker — Tax Summary Widget
// Scriptable widget, adapts automatically to small / medium / large sizes.
//
// SETUP:
// 1. In the Rover Tracker .env file on your server, set WIDGET_API_KEY to a
//    random string (already added if you pulled the latest update).
// 2. Fill in API_URL and WIDGET_KEY below.
// 3. Save this script in Scriptable (e.g. named "Side Job Tax Widget").
// 4. Long-press your home screen → add a Scriptable widget → choose this
//    script → pick any size (small, medium, or large all work).

const API_URL = "https://rover.megangibbs.net"; // no trailing slash
const WIDGET_KEY = "PASTE_YOUR_WIDGET_API_KEY_HERE";
const JOB_ID = "all"; // 'all' = combined tax picture across every job

// ---- Colors (adapt to iOS light/dark automatically) ----
const bgColor = Color.dynamic(new Color("#ffffff"), new Color("#1b1b1a"));
const cardColor = Color.dynamic(new Color("#f7f5f1"), new Color("#262524"));
const textColor = Color.dynamic(new Color("#2b2b2b"), new Color("#ecebe8"));
const mutedColor = Color.dynamic(new Color("#777777"), new Color("#9a9892"));
const accentColor = new Color("#2a8a5f");
const redColor = new Color("#c0392b");
const amberColor = new Color("#b8860b");

async function fetchSummary() {
  const url = `${API_URL}/api/widget/summary?key=${encodeURIComponent(WIDGET_KEY)}&job_id=${JOB_ID}`;
  const req = new Request(url);
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  if (data.error) throw new Error(data.error);
  return data;
}

function fmtMoney(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function buildErrorWidget(message) {
  const w = new ListWidget();
  w.backgroundColor = bgColor;
  w.setPadding(14, 14, 14, 14);
  const t = w.addText("⚠️ " + message);
  t.textColor = redColor;
  t.font = Font.systemFont(12);
  return w;
}

function buildWidget(data, family) {
  const w = new ListWidget();
  w.backgroundColor = bgColor;
  w.setPadding(14, 14, 14, 14);

  const title = w.addText("🐾 " + data.jobLabel);
  title.font = Font.boldSystemFont(family === "small" ? 13 : 15);
  title.textColor = textColor;
  w.addSpacer(family === "small" ? 6 : 10);

  if (family === "small") {
    // Small: just the two numbers that matter most
    addLabelValue(w, "Net Profit", fmtMoney(data.netProfit), textColor, family);
    w.addSpacer(6);
    addLabelValue(w, "Est. Tax Owed", fmtMoney(data.totalTax), amberColor, family);
    w.addSpacer(8);
    const banner = w.addText(data.quarterlyRequired ? "Quarterly due" : "Under $1,000");
    banner.font = Font.systemFont(10);
    banner.textColor = data.quarterlyRequired ? redColor : accentColor;
    return w;
  }

  if (family === "medium") {
    const row = w.addStack();
    row.layoutHorizontally();

    const col1 = row.addStack();
    col1.layoutVertically();
    addLabelValue(col1, "Income", fmtMoney(data.income), accentColor, family);
    addLabelValue(col1, "Expenses", fmtMoney(data.expenses), redColor, family);

    row.addSpacer();

    const col2 = row.addStack();
    col2.layoutVertically();
    addLabelValue(col2, "Net Profit", fmtMoney(data.netProfit), textColor, family);
    addLabelValue(col2, "Est. Tax", fmtMoney(data.totalTax), amberColor, family);

    w.addSpacer(10);
    const banner = w.addText(
      data.quarterlyRequired
        ? `Quarterly payment due: ~${fmtMoney(data.quarterlyPayment)}`
        : "Below $1,000 — quarterly likely not required"
    );
    banner.font = Font.systemFont(11);
    banner.textColor = data.quarterlyRequired ? redColor : accentColor;
    return w;
  }

  // Large: full breakdown
  const grid = w.addStack();
  grid.layoutVertically();

  const row1 = grid.addStack();
  row1.layoutHorizontally();
  const r1c1 = row1.addStack(); r1c1.layoutVertically();
  addLabelValue(r1c1, "Income", fmtMoney(data.income), accentColor, family);
  row1.addSpacer();
  const r1c2 = row1.addStack(); r1c2.layoutVertically();
  addLabelValue(r1c2, "Expenses", fmtMoney(data.expenses), redColor, family);
  row1.addSpacer();
  const r1c3 = row1.addStack(); r1c3.layoutVertically();
  addLabelValue(r1c3, "Mileage Ded.", fmtMoney(data.mileageDeduction), accentColor, family);

  grid.addSpacer(10);
  const divider = grid.addStack();
  divider.size = new Size(0, 1);
  divider.backgroundColor = mutedColor;

  grid.addSpacer(10);
  addLabelValue(grid, "Net Profit", fmtMoney(data.netProfit), textColor, family, true);

  grid.addSpacer(8);
  const row2 = grid.addStack();
  row2.layoutHorizontally();
  const r2c1 = row2.addStack(); r2c1.layoutVertically();
  addLabelValue(r2c1, "SE Tax", fmtMoney(data.seTax), textColor, family);
  row2.addSpacer();
  const r2c2 = row2.addStack(); r2c2.layoutVertically();
  addLabelValue(r2c2, "Federal", fmtMoney(data.federalTax), textColor, family);
  row2.addSpacer();
  const r2c3 = row2.addStack(); r2c3.layoutVertically();
  addLabelValue(r2c3, "State", fmtMoney(data.stateTax), textColor, family);

  grid.addSpacer(8);
  addLabelValue(grid, "Total Estimated Tax", fmtMoney(data.totalTax), amberColor, family, true);

  grid.addSpacer(10);
  const bannerBg = grid.addStack();
  bannerBg.layoutVertically();
  bannerBg.backgroundColor = cardColor;
  bannerBg.cornerRadius = 8;
  bannerBg.setPadding(8, 10, 8, 10);
  const banner = bannerBg.addText(
    data.quarterlyRequired
      ? `Quarterly payment likely required — ~${fmtMoney(data.quarterlyPayment)}/quarter`
      : "Below the $1,000 threshold — quarterly payments likely not required"
  );
  banner.font = Font.systemFont(11);
  banner.textColor = data.quarterlyRequired ? redColor : accentColor;

  return w;
}

function addLabelValue(container, label, value, valueColor, family, big) {
  const labelText = container.addText(label.toUpperCase());
  labelText.font = Font.systemFont(family === "small" ? 8 : 9);
  labelText.textColor = mutedColor;
  container.addSpacer(2);
  const valueText = container.addText(value);
  valueText.font = big
    ? Font.boldSystemFont(family === "small" ? 16 : 20)
    : Font.boldSystemFont(family === "small" ? 14 : 16);
  valueText.textColor = valueColor;
}

// ---- Main ----
let widget;
try {
  const data = await fetchSummary();
  const family = config.widgetFamily || "medium"; // default when running in-app preview
  widget = buildWidget(data, family);
} catch (err) {
  widget = buildErrorWidget(err.message || "Could not load data");
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Preview in-app when running the script manually
  await widget.presentMedium();
}
Script.complete();
