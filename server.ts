import "dotenv/config";
import express from "express";
import path from "path";
import QRCode from "qrcode";
import sharp from "sharp";
import { fileURLToPath } from "url";
import {
  callJORFSearchOrganisationName,
  callJORFSearchPeople,
  callJORFSearchTag,
} from "./JORFSearch.utils.ts";
import umami from "./umami.ts";
import fs from "fs/promises";

type FollowType = "people" | "function_tag" | "organisation";

const app = express();

const { APP_DOMAIN, PORT, TELEGRAM_BOT_NAME, WHATSAPP_PHONE_NUMBER } =
  process.env;

if (APP_DOMAIN === undefined || PORT === undefined) {
  throw new Error("Missing APP_DOMAIN or PORT environment variables");
}

if (TELEGRAM_BOT_NAME === undefined || WHATSAPP_PHONE_NUMBER === undefined) {
  throw new Error(
    "Missing TELEGRAM_BOT_NAME or WHATSAPP_PHONE_NUMBER environment variables",
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHOOSE_PAGE_CONTENT = await fs.readFile(
  path.join(__dirname, "choose.html"),
  "utf8",
);

const APP_URL = `http://${APP_DOMAIN}`;
const FRAME_PATH = path.join(__dirname, "frame.png");

app.use(express.static(path.join(__dirname)));

const DEFAULT_QRCODE_SIZE = 500;

const FONT_SIZE = 40;
const TEXT_COLOR = "#62676c"; // gris JOÉL

// API endpoint: /api/qrcode?url=https://example.com&size=500
app.get("/qrcode", async (req, res) => {
  try {
    // Output size
    let qr_code_size = parseInt(req.query.size as string);
    if (isNaN(qr_code_size)) qr_code_size = DEFAULT_QRCODE_SIZE;

    let frameEnabled = true;
    if (req.query.frame != undefined && req.query.frame === "false")
      frameEnabled = false;

    if (req.query.size != undefined && frameEnabled)
      return res
        .status(400)
        .json({ error: "Cannot use fixed size and frame at the same tile." });

    // Verify on JORFSearch before generation
    let verifyOnJORFSearch = false;
    if (req.query.verify != undefined)
      verifyOnJORFSearch = Boolean(req.query.verify);

    // Type of follow: name, function_tag, organisation
    let followType: FollowType | undefined;

    // name for people
    const name = (req.query.name ?? "") as string;
    if (name.length > 0) {
      if (name.split(" ").length > 2)
        return res.status(400).json({
          error:
            "Name parameter must be composed two words minimum: firstname lastname.",
        });
      followType = "people";
    }

    // organisation
    const organisation = (req.query.organisation ?? "") as string;
    if (organisation.length > 0) {
      if (followType != undefined)
        return res.status(400).json({
          error:
            "Parameters people, function_tag and organisations are exclusive.",
        });
      followType = "organisation";
      verifyOnJORFSearch = true; // must verify to get the name from JORF
    }

    // function_tag
    const function_tag = (req.query.function_tag ?? "") as string;
    if (function_tag.length > 0) {
      if (followType != undefined)
        return res.status(400).json({
          error:
            "Parameters people, function_tag and organisations are exclusive.",
        });
      followType = "function_tag";
    }

    if (followType == undefined)
      return res.status(400).json({
        error:
          "One of people, function_tag and organisations must be provided.",
      });

    let followLabel;
    let qr_url;
    switch (followType) {
      case "people": {
        let prenomNom = name;
        if (verifyOnJORFSearch) {
          const JORFResult = await callJORFSearchPeople(name);
          if (JORFResult.length === 0)
            return res
              .status(400)
              .json({ error: "No result found on JORFSearch." });
          prenomNom = `${JORFResult[0].prenom} ${JORFResult[0].nom}`;
        }
        qr_url = encodeURI(`${APP_URL}/choose?name=${prenomNom}`);
        followLabel = prenomNom;
        break;
      }

      case "organisation": {
        const JORFResult = await callJORFSearchOrganisationName(organisation);
        if (JORFResult.length === 0)
          return res
            .status(400)
            .json({ error: "No result found on JORFSearch." });
        if (JORFResult.length > 1)
          return res
            .status(400)
            .json({ error: "Too many results found on JORFSearch." });
        qr_url = encodeURI(`${APP_URL}/choose?&organisation=${organisation}`);
        followLabel = JORFResult[0].name;
        break;
      }

      case "function_tag": {
        if (verifyOnJORFSearch) {
          const JORFResult = await callJORFSearchTag(function_tag);
          if (JORFResult.length === 0)
            return res
              .status(400)
              .json({ error: "No result found on JORFSearch." });
        }
        qr_url = encodeURI(`${APP_URL}/choose?&function_tag=${function_tag}`);
        followLabel = function_tag;
        break;
      }
    }

    const qrBuffer = await QRCode.toBuffer(qr_url, {
      width: qr_code_size,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    res.set("Content-Type", "image/png");

    if (!frameEnabled) {
      res.send(qrBuffer);
      console.log("QR code generated successfully.");
      return;
    }

    /* 2) métadonnées du template ------------------------------------------ */
    const frame = sharp(FRAME_PATH);
    const { width: frameW = 0, height: frameH = 0 } = await frame.metadata();

    /* 3) coordonnées du QR (centre bas) ----------------------------------- */
    const left = Math.round((frameW - qr_code_size) / 2);
    const top = Math.round(frameH * 0.45); // ~55 % de hauteur

    /* 4) overlay SVG pour le texte dynamique ------------------------------ */
    const textSvg = `
    <svg width="${String(frameW)}" height="${String(FONT_SIZE * 3)}"
         viewBox="0 0 ${String(frameW)} ${String(FONT_SIZE * 3)}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .label { font-family: Helvetica, Arial, sans-serif;
                 font-weight: 700;
                 font-size: ${String(FONT_SIZE)};
                 fill: ${TEXT_COLOR}; }
      </style>

      <text x="50%" y="70%" dominant-baseline="middle" text-anchor="middle" class="label">
        ${followLabel}
      </text>
    </svg>`;
    const textBuffer = Buffer.from(textSvg);

    /* 5) composition finale ----------------------------------------------- */
    const outputBuffer = await frame
      .composite([
        { input: qrBuffer, left, top }, // QR
        { input: textBuffer, left: 0, top: Math.round(frameH * 0.35) }, // ligne texte
      ])
      .png()
      .toBuffer();

    res.set("Content-Type", "image/png");
    res.send(outputBuffer);

    switch (followType) {
      case "people":
        await umami.log({ event: "/qrcode-people" });
        break;
      case "organisation":
        await umami.log({ event: "/qrcode-organisation" });
        break;
      case "function_tag":
        await umami.log({ event: "/qrcode-tag" });
        break;
    }
  } catch (err) {
    console.error("QR API error:", err);
    res.status(500).json({ error: "QR code generation failed." });
  }
});

app.get("/choose", async (req, res) => {
  try {
    let content = CHOOSE_PAGE_CONTENT;

    const paramsNames = ["name", "organisation", "people", "verify"];

    const paramsWithValues: string[] = [];
    paramsNames.forEach((param) => {
      const paramValue = (req.query[param] ?? "") as string;
      if (paramValue.length > 0)
        paramsWithValues.push(`${param}=${paramValue}`);
    });
    paramsWithValues.push("frame=false");

    let followType: FollowType | undefined;
    let followArg = ""; // to be sent to the start command
    let followLabel = ""; // visually shown on the page to the user

    if (req.query.name != undefined) {
      followArg = req.query.name as string;
      if (followArg.split(" ").length < 2)
        return res.status(400).json({
          error:
            "Name parameter must be composed two words minimum: firstname lastname.",
        });
      followType = "people";
      followLabel = followArg;
    }

    if (req.query.organisation != undefined) {
      followArg = req.query.organisation as string;
      if (followType != undefined)
        return res.status(400).json({
          error:
            "Parameters people, function_tag and organisations are exclusive.",
        });
      followType = "organisation";
      const JORFResult = await callJORFSearchOrganisationName(followArg);
      if (JORFResult.length === 0)
        return res
          .status(400)
          .json({ error: "No result found on JORFSearch." });
      if (JORFResult.length > 1)
        return res
          .status(400)
          .json({ error: "Too many results found on JORFSearch." });
      followLabel = JORFResult[0].name;
    }

    if (req.query.function_tag != undefined) {
      followArg = req.query.function_tag as string;
      if (followType != undefined)
        return res.status(400).json({
          error:
            "Parameters people, function_tag and organisations are exclusive.",
        });
      followType = "function_tag";
      followLabel = followArg; // TODO: replace by a cleaner tag name
    }

    const isMobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        req.get("user-agent") ?? "",
      );

    content = content.replace(
      "{QR_URL}",
      `${APP_URL}/qrcode?${encodeURI(paramsWithValues.join("&"))}`,
    );

    // Hide the QR code if already on mobile
    content = content.replace("{HIDDEN_QR}", isMobile ? "hidden" : "");

    // Show the display name
    content = content.replace("{FOLLOW_LABEL}", followLabel);

    // Show the display name
    content = content.replace("{BASE_URL}", APP_URL);

    const telegram_base_URL = `https://t.me/${TELEGRAM_BOT_NAME}?text=`;
    const whatsapp_base_URL = `https://wa.me/${WHATSAPP_PHONE_NUMBER}?text=Bonjour JOEL! `;

    let startCommand = "";

    switch (followType) {
      case "people":
        startCommand = "Suivre " + followArg;
        await umami.log({ event: "/gateway-people" });
        break;
      case "organisation":
        startCommand = "SuivreO " + followArg;
        await umami.log({ event: "/gateway-organisation" });
        break;
      case "function_tag":
        startCommand = "SuivreF " + followArg;
        await umami.log({ event: "/gateway-tag" });
        break;
    }

    content = content.replace(
      "{WHATSAPP_LINK}",
      encodeURI(whatsapp_base_URL + startCommand),
    );
    content = content.replace(
      "{TELEGRAM_LINK}",
      encodeURI(telegram_base_URL + startCommand.replace("Suivre", "Rechercher") // flow is prettier with "Rechercher"
      ),
    );

    res.type("html").send(content);
  } catch (err) {
    console.error("QR API error:", err);
    res.status(500).json({ error: "QR code generation failed." });
  }
});

app.get("/", (req, res) => {
    res.type("text/plain").send("JOEL QR server is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 App running at APP_URL`);
  console.log(`📱 Try: ${APP_URL}/qrcode`);
});
