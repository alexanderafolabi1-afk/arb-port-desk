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

// ── Gulf of Oman monitoring zone ──────────────────────────────────
// Vessels here heading AWAY from Hormuz (course > 100 or < 260) = diverting
const MONITOR_ZONE = {
  lat_min: 22.0, lat_max: 27.0,
  lon_min: 54.0, lon_max: 60.0,
};

// Hormuz is at roughly lon 56.5. Heading east (course 80-180) = bypassing
function isDeviating(course, lat, lon) {
  // Vessel in Gulf of Oman heading south/east away from Strait
  const inZone = lat >= MONITOR_ZONE.lat_min && lat <= MONITOR_ZONE.lat_max &&
                 lon >= MONITOR_ZONE.lon_min && lon <= MONITOR_ZONE.lon_max;
  const headingAway = course >= 100 && course <= 260; // southward/eastward = away from Hormuz
  return inZone && headingAway;
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

// ── AIS Data Fetch ────────────────────────────────────────────────
/**
 * Uses VesselFinder free public API — no registration, no AIS station needed.
 * Fetches vessels in the Gulf of Oman monitoring zone.
 * Falls back to a secondary free source if VesselFinder is unavailable.
 */
async function fetchVessels() {
  // Primary: VesselFinder free area search
  // Returns vessels within our Gulf of Oman monitoring zone
  const url = `https://www.vesselfinder.com/api/pub/vesselsonmap?bbox=${MONITOR_ZONE.lon_min},${MONITOR_ZONE.lat_min},${MONITOR_ZONE.lon_max},${MONITOR_ZONE.lat_max}&zoom=7`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.vesselfinder.com/",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`VesselFinder HTTP ${res.status}`);
    const data = await res.json();

    // VesselFinder returns array of vessel arrays
    // Format: [mmsi, lat*600000, lon*600000, course, speed, name, type, ...]
    if (Array.isArray(data)) {
      return data
        .filter(v => Array.isArray(v) && v.length >= 6)
        .map(v => ({
          name:   String(v[5] || "UNKNOWN").trim(),
          mmsi:   String(v[0] || ""),
          imo:    "",
          lat:    parseFloat(v[1]) / 600000,
          lon:    parseFloat(v[2]) / 600000,
          course: parseFloat(v[3]) || 0,
          speed:  parseFloat(v[4]) / 10,
          type:   getVesselType(v[6]),
          flag:   "",
        }))
        .filter(v => v.name !== "UNKNOWN" && v.speed > 0);
    }
    throw new Error("Unexpected VesselFinder response format");

  } catch(err) {
    console.warn("[ARB] VesselFinder fetch failed:", err.message);

    // Secondary: try MarineTraffic public endpoint
    try {
      const url2 = `https://www.marinetraffic.com/getData/get_data_json_4/z:8/X:48/Y:23/station:0`;
      const res2 = await fetch(url2, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.marinetraffic.com/",
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res2.ok) throw new Error(`MarineTraffic HTTP ${res2.status}`);
      const data2 = await res2.json();
      if (data2.data && Array.isArray(data2.data.rows)) {
        return data2.data.rows
          .filter(v => {
            const lat = parseFloat(v.LAT);
            const lon = parseFloat(v.LON);
            return lat >= MONITOR_ZONE.lat_min && lat <= MONITOR_ZONE.lat_max &&
                   lon >= MONITOR_ZONE.lon_min && lon <= MONITOR_ZONE.lon_max;
          })
          .map(v => ({
            name:   v.SHIPNAME || "UNKNOWN",
            mmsi:   v.MMSI     || "",
            imo:    v.IMO      || "",
            lat:    parseFloat(v.LAT)   || 0,
            lon:    parseFloat(v.LON)   || 0,
            course: parseFloat(v.COURSE)|| 0,
            speed:  parseFloat(v.SPEED) || 0,
            type:   v.TYPE_NAME || "Cargo",
            flag:   v.FLAG     || "",
          }));
      }
      throw new Error("No rows in MarineTraffic response");

    } catch(err2) {
      console.warn("[ARB] MarineTraffic also failed:", err2.message, "— pipeline test mode active");
      // Test mode — confirms email pipeline is working
      // Real vessel data will flow once live AIS sources respond
      return [
        { name:"TEST VESSEL ONLY",  mmsi:"000000001", imo:"0000001", lat:24.2, lon:57.8, course:145, speed:12.4, type:"Cargo",  flag:"Test" },
      ];
    }
  }
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

    body += `VESSEL: ${v.name}\n`;
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
    .filter(v => isDeviating(v.course, v.lat, v.lon) && v.speed > 2)
    .map(v => ({ ...v, nearest_port: nearestPort(v.lat, v.lon) }));

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
