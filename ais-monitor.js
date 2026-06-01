/**
 * ARB Vessel Diversion Monitor
 * Runs hourly via GitHub Actions.
 *
 * What this does automatically — you do nothing:
 *  1. Pulls live AIS vessel data from AISHub free API
 *  2. Identifies vessels in the Gulf of Oman heading AWAY from Hormuz
 *  3. Matches each vessel to the nearest alternative diversion port
 *  4. Sends a full outreach email alert to alex@thearbgroup.co.uk
 *     with the vessel details and a ready-to-forward pitch
 *
 * You receive an email. You forward it. You earn £2,500.
 */

"use strict";
const nodemailer = require("nodemailer");

const ZOHO_USER   = process.env.ZOHO_USER;   // alex@thearbgroup.co.uk
const ZOHO_PASS   = process.env.ZOHO_PASS;   // App password from Zoho
const ALERT_EMAIL = process.env.ALERT_EMAIL; // alex@thearbgroup.co.uk

// ── Alternative Diversion Ports ──────────────────────────────────
const PORTS = [
  {
    id: "fujairah", name: "Port of Fujairah", country: "UAE",
    lat: 25.1288, lon: 56.3573,
    agent_email: "fujairah@gac.com",
    agent_name: "GAC Shipping UAE",
    agent_phone: "+971 9 222 4400",
    notice_hrs: 12,
  },
  {
    id: "salalah", name: "Port of Salalah", country: "Oman",
    lat: 16.9390, lon: 54.0083,
    agent_email: "salalah@iss-shipping.com",
    agent_name: "Inchcape Shipping Services",
    agent_phone: "+968 2329 5700",
    notice_hrs: 12,
  },
  {
    id: "colombo", name: "Port of Colombo", country: "Sri Lanka",
    lat: 6.9271, lon: 79.8612,
    agent_email: "colombo@gac.com",
    agent_name: "GAC Shipping Sri Lanka",
    agent_phone: "+94 11 247 5000",
    notice_hrs: 24,
  },
  {
    id: "durban", name: "Port of Durban", country: "South Africa",
    lat: -29.8587, lon: 31.0218,
    agent_email: "maritime@barloworld.co.za",
    agent_name: "Barloworld Logistics Maritime",
    agent_phone: "+27 31 361 9000",
    notice_hrs: 24,
  },
  {
    id: "singapore", name: "Port of Singapore", country: "Singapore",
    lat: 1.2644, lon: 103.8228,
    agent_email: "singapore@gac.com",
    agent_name: "GAC Shipping Singapore",
    agent_phone: "+65 6278 6482",
    notice_hrs: 24,
  },
  {
    id: "mumbai", name: "Nhava Sheva — Mumbai", country: "India",
    lat: 18.9500, lon: 72.9500,
    agent_email: "mumbai@gac.com",
    agent_name: "GAC Shipping India",
    agent_phone: "+91 22 6618 1000",
    notice_hrs: 36,
  },
];

// ── Monitoring zones — Gulf of Oman + Red Sea + Arabian Sea ──────
// Three zones covering all major diversion corridors
const MONITOR_ZONES = [
  {
    id: "gulf_oman",
    name: "Gulf of Oman",
    description: "Vessels deviating from Strait of Hormuz",
    lat_min: 22.0, lat_max: 27.0,
    lon_min: 54.0, lon_max: 62.0,
    // Heading south/east = bypassing Hormuz
    deviating_course_min: 100, deviating_course_max: 260,
  },
  {
    id: "red_sea",
    name: "Red Sea",
    description: "Vessels avoiding Bab el-Mandeb / Houthi threat zone",
    lat_min: 12.0, lat_max: 22.0,
    lon_min: 38.0, lon_max: 45.0,
    // Heading west/south = diverting away from Suez route
    deviating_course_min: 150, deviating_course_max: 300,
  },
  {
    id: "arabian_sea",
    name: "Arabian Sea",
    description: "Vessels rerouting around Indian Ocean",
    lat_min: 10.0, lat_max: 22.0,
    lon_min: 55.0, lon_max: 68.0,
    // Any vessel at slow speed in this zone during conflict = potential diversion
    deviating_course_min: 80, deviating_course_max: 280,
  },
];

// Keep a flat zone for AISStream bounding box (use combined area)
const MONITOR_ZONE = {
  lat_min: 10.0, lat_max: 27.0,
  lon_min: 38.0, lon_max: 68.0,
};

function isDeviating(course, lat, lon) {
  for (const zone of MONITOR_ZONES) {
    const inZone = lat >= zone.lat_min && lat <= zone.lat_max &&
                   lon >= zone.lon_min && lon <= zone.lon_max;
    const headingAway = course >= zone.deviating_course_min &&
                        course <= zone.deviating_course_max;
    if (inZone && headingAway) return { deviating: true, zone: zone.name };
  }
  return { deviating: false, zone: null };
}

function getZoneName(lat, lon) {
  for (const zone of MONITOR_ZONES) {
    if (lat >= zone.lat_min && lat <= zone.lat_max &&
        lon >= zone.lon_min && lon <= zone.lon_max) return zone.name;
  }
  return "Unknown Zone";
}

function nearestPort(lat, lon) {
  let nearest = PORTS[0], minDist = Infinity;
  for (const port of PORTS) {
    const d = Math.sqrt(Math.pow(port.lat - lat, 2) + Math.pow(port.lon - lon, 2));
    if (d < minDist) { minDist = d; nearest = port; }
  }
  return nearest;
}

function distanceNM(lat1, lon1, lat2, lon2) {
  const R = 3440; // nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
            Math.sin(dLon/2)*Math.sin(dLon/2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// ── AIS Data Fetch via AISStream.io ──────────────────────────────
/**
 * AISStream.io — free WebSocket AIS feed, no AIS station needed.
 * API key stored in GitHub Secrets as AISSTREAM_KEY.
 * Subscribes to vessel position messages in the Gulf of Oman zone.
 * Collects data for 15 seconds then closes the connection.
 */
const AISSTREAM_KEY = process.env.AISSTREAM_KEY;

async function fetchVessels() {
  return new Promise((resolve) => {
    const vessels = new Map();
    const timeout = setTimeout(() => {
      ws.close();
      resolve(Array.from(vessels.values()));
    }, 15000); // collect for 15 seconds

    let ws;
    try {
      const { WebSocket } = require("ws");
      ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

      ws.on("open", () => {
        console.log("[ARB] Connected to AISStream.io");
        ws.send(JSON.stringify({
          APIKey: AISSTREAM_KEY,
          BoundingBoxes: [[
            [MONITOR_ZONE.lat_min, MONITOR_ZONE.lon_min],
            [MONITOR_ZONE.lat_max, MONITOR_ZONE.lon_max],
          ]],
          FilterMessageTypes: ["PositionReport"],
        }));
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.MessageType !== "PositionReport") return;
          const p   = msg.Message?.PositionReport;
          const meta = msg.MetaData;
          if (!p || !meta) return;
          vessels.set(meta.MMSI, {
            name:   meta.ShipName?.trim() || "UNKNOWN",
            mmsi:   String(meta.MMSI || ""),
            imo:    "",
            lat:    parseFloat(p.Latitude)  || 0,
            lon:    parseFloat(p.Longitude) || 0,
            course: parseFloat(p.TrueHeading || p.Cog) || 0,
            speed:  parseFloat(p.Sog) || 0,
            type:   "Cargo",
            flag:   meta.flag || "",
          });
        } catch(e) {}
      });

      ws.on("error", (err) => {
        console.warn("[ARB] AISStream error:", err.message);
        clearTimeout(timeout);
        ws.close();
        resolve(Array.from(vessels.values()));
      });

      ws.on("close", () => {
        clearTimeout(timeout);
        resolve(Array.from(vessels.values()));
      });

    } catch(err) {
      console.warn("[ARB] WebSocket setup failed:", err.message);
      clearTimeout(timeout);
      resolve([]);
    }
  });
}

function getVesselType(code) {
  const types = { 1:"Cargo", 2:"Tanker", 3:"Passenger", 4:"HSC", 6:"Bulk", 7:"Other" };
  return types[parseInt(code)] || "Cargo";
}

// ── Email Builder ─────────────────────────────────────────────────
function buildAlertEmail(vessels, divertingVessels) {
  const today   = new Date();
  const fmtDate = d => d.toLocaleDateString("en-GB", {day:"2-digit",month:"long",year:"numeric"});
  const fmtTime = d => d.toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit",timeZone:"Europe/London"}) + " BST";

  let body = `ARB PORT COORDINATION DESK — VESSEL DIVERSION ALERT\n`;
  body += `${"─".repeat(60)}\n`;
  body += `Date: ${fmtDate(today)}\n`;
  body += `Time: ${fmtTime(today)}\n`;
  body += `Vessels scanned: ${vessels.length}\n`;
  body += `Diversions detected: ${divertingVessels.length}\n`;
  body += `${"─".repeat(60)}\n\n`;

  if (divertingVessels.length === 0) {
    body += `No vessel diversions detected in this scan.\n`;
    body += `Monitoring zone: Gulf of Oman (${MONITOR_ZONE.lat_min}°N–${MONITOR_ZONE.lat_max}°N, ${MONITOR_ZONE.lon_min}°E–${MONITOR_ZONE.lon_max}°E)\n`;
    body += `Next scan: 1 hour\n`;
    return { subject: `[ARB] No Diversions Detected — ${fmtDate(today)}`, body };
  }

  for (const v of divertingVessels) {
    const port   = v.nearest_port;
    const distNM = distanceNM(v.lat, v.lon, port.lat, port.lon);
    const etaHrs = Math.round(distNM / Math.max(v.speed, 8));
    const etaDate = new Date(today.getTime() + etaHrs * 3600000);
    const fmtETA  = d => d.toLocaleDateString("en-GB",{day:"2-digit",month:"short"}) + " " + d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});

    body += `VESSEL: ${v.name} [${v.zone || "Gulf Region"}]\n`;
    body += `MMSI: ${v.mmsi} | IMO: ${v.imo || "N/A"} | Flag: ${v.flag}\n`;
    body += `Type: ${v.type} | Speed: ${v.speed} kn | Course: ${v.course}°\n`;
    body += `Position: ${v.lat.toFixed(4)}°N ${v.lon.toFixed(4)}°E\n`;
    body += `Status: DEVIATING — heading away from Strait of Hormuz\n\n`;
    body += `MarineTraffic: https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}\n`;
    body += `NEAREST ALTERNATIVE PORT: ${port.name}, ${port.country}\n`;
    body += `Distance: ~${distNM} nautical miles\n`;
    body += `ETA (estimated): ${fmtETA(etaDate)}\n`;
    body += `Port agent: ${port.agent_name}\n`;
    body += `Agent contact: ${port.agent_email} | ${port.agent_phone}\n`;
    body += `Berth notice required: ${port.notice_hrs} hours\n\n`;
    body += `YOUR COORDINATION FEE: £2,500\n\n`;
    body += `${"─".repeat(40)}\n`;
    body += `READY-TO-FORWARD OUTREACH EMAIL\n`;
    body += `Forward this section to the vessel operator or ship manager:\n`;
    body += `${"─".repeat(40)}\n\n`;
    body += buildOperatorEmail(v, port, fmtDate(today), fmtETA(etaDate));
    body += `\n${"─".repeat(60)}\n\n`;
  }

  return {
    subject: `[ARB] ${divertingVessels.length} Vessel Diversion${divertingVessels.length > 1 ? "s" : ""} Detected — £${(divertingVessels.length * 2500).toLocaleString()} Opportunity — ${fmtDate(today)}`,
    body,
  };
}

function buildOperatorEmail(vessel, port, today, eta) {
  return `To: [Vessel Operator / Ship Manager Email]
Subject: Emergency Port Coordination — ${vessel.name} — ${port.name}

For the Attention of the Operations Desk

${today}

Dear Operations Team,

Re: Emergency Alternative Port Call — ${vessel.name}${vessel.imo ? " (IMO: " + vessel.imo + ")" : ""}

I am writing on behalf of The ARB Group in connection with emergency port coordination services for the above vessel, which our monitoring systems have identified as deviating from original Gulf routing due to the ongoing Strait of Hormuz disruption.

We have immediate coordination capability at ${port.name}, ${port.country} and can arrange the following on your behalf:

  Berth allocation and booking
  Bunker supply coordination
  Provisions and fresh water
  Port agency representation throughout

Vessel details confirmed by AIS:
  Position:  ${vessel.lat.toFixed(4)}N ${vessel.lon.toFixed(4)}E
  Course:    ${vessel.course}°
  Speed:     ${vessel.speed} knots
  ETA ${port.name}: ${eta}

Our coordination fee is £2,500 flat, covering full liaison from initial contact through to vessel departure. All port dues and disbursements are additional and billed directly.

We are ready to activate on your instruction.

Yours faithfully,

Alex Afolabi
Director, The ARB Group
alex@thearbgroup.co.uk
07497 149266
Available 24/7

This communication is protected under a Non-Circumvention and Fee Protection Agreement. All coordination fees are protected and payable to The ARB Group.`;
}

// ── Email Sender via Zoho SMTP ────────────────────────────────────
async function sendAlert(subject, body) {
  const transporter = nodemailer.createTransport({
    host: "smtp.zoho.eu",
    port: 587,
    secure: false,
    auth: {
      user: ZOHO_USER,
      pass: ZOHO_PASS,
    },
  });

  await transporter.sendMail({
    from: `"ARB Monitor" <${ZOHO_USER}>`,
    to:   ALERT_EMAIL,
    subject,
    text: body,
  });

  console.log(`[ARB] Alert sent: ${subject}`);
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const t = Date.now();
  console.log(`[ARB] ─── Vessel scan started: ${new Date().toUTCString()} ───`);

  if (!ZOHO_USER || !ZOHO_PASS || !ALERT_EMAIL) {
    throw new Error("ZOHO_USER, ZOHO_PASS, and ALERT_EMAIL must be set in GitHub Secrets.");
  }

  // 1. Fetch live AIS data
  console.log("[ARB] Fetching AIS vessel data from Gulf of Oman monitoring zone...");
  const vessels = await fetchVessels();
  console.log(`[ARB] ${vessels.length} vessels detected in monitoring zone`);

  // 2. Identify deviating vessels
  const deviating = vessels
    .filter(v => {
      const result = isDeviating(v.course, v.lat, v.lon);
      return result.deviating && v.speed > 2;
    })
    .map(v => ({
      ...v,
      nearest_port: nearestPort(v.lat, v.lon),
      zone: getZoneName(v.lat, v.lon),
    }));

  console.log(`[ARB] ${deviating.length} deviating vessel(s) identified`);
  deviating.forEach(v => console.log(`[ARB]   ${v.name} — Course ${v.course}° — Nearest: ${v.nearest_port.name}`));

  // 3. Send alert email (always send — no deviation = confirmation system is working)
  if (deviating.length > 0 || new Date().getUTCHours() === 7) {
    // Send alert for any diversions, OR send daily 07:00 UTC summary even if clear
    const { subject, body } = buildAlertEmail(vessels, deviating);
    await sendAlert(subject, body);
  } else {
    console.log("[ARB] No diversions detected. Silent check complete.");
  }

  console.log(`[ARB] ─── Done in ${Date.now()-t}ms ───`);
}

main().catch(err => { console.error("[ARB] Fatal:", err.message); process.exit(1); });
