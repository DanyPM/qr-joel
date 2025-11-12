import "dotenv/config";
import express from "express";
import path from "path";
import QRCode from "qrcode";
import sharp from "sharp";
import { fileURLToPath } from "url";
import {
  callJORFSearchOrganisationByWikidataId,
  callJORFSearchPeople,
  callJORFSearchTag,
} from "./JORFSearch.utils.ts";
import umami from "./umami.ts";
import fs from "fs/promises";

type FollowType = "people" | "function_tag" | "organisation";

const app = express();

const {
  PORT,
  TELEGRAM_BOT_NAME,
  WHATSAPP_BOT__PHONE_NUMBER,
  MATRIX_BOT_USERNAME,
  TCHAP_BOT_USERNAME,
} = process.env;

const isDev = process.env.NODE_ENV === "development";

const HOME_WEBSITE_URL = "joel-officiel.fr";
const APP_DOMAIN = isDev ? "localhost" : "links.joel-officiel.fr";

let appPort = PORT ? parseInt(PORT) : null;
appPort ??= 3000;

const PAGE_TITLE_DEFAULT = "JOEL - Journal Electronique";
const PAGE_TITLE_WITH_NAME = "Suivre {NAME} sur JOEL - Journal Electronique";

const whatsappLinkBase = WHATSAPP_BOT__PHONE_NUMBER
  ? `https://wa.me/${WHATSAPP_BOT__PHONE_NUMBER}?text=Bonjour JOEL!`
  : null;
const hasWhatsapp = WHATSAPP_BOT__PHONE_NUMBER != null;

const telegramLinkBase = TELEGRAM_BOT_NAME
  ? `https://t.me/${TELEGRAM_BOT_NAME}?text=Bonjour JOEL!`
  : null;
const hasTelegram = TELEGRAM_BOT_NAME != null;

const matrixLinkBase = MATRIX_BOT_USERNAME
  ? `https://matrix.to/#/@${MATRIX_BOT_USERNAME}`
  : null;
const hasMatrix = MATRIX_BOT_USERNAME != null;

const tchapLinkBase = TCHAP_BOT_USERNAME
  ? `https://www.tchap.gouv.fr/#/@${TCHAP_BOT_USERNAME}`
  : null;
const hasTchap = TCHAP_BOT_USERNAME != null;

const signalLinkBase = null;
const hasSignal = false;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (!hasTelegram && !hasWhatsapp && !hasMatrix && !hasTchap && !hasSignal) {
  throw new Error(
    "Missing messenger configuration. Set TELEGRAM_BOT_NAME, WHATSAPP_PHONE_NUMBER, MATRIX_BOT_USERNAME or TCHAP_BOT_USERNAME environment variables.",
  );
}

if (
  process.env.NODE_ENV !== "development" &&
  (process.env.UMAMI_HOST === undefined || process.env.UMAMI_ID === undefined)
) {
  throw new Error("UMAMI env not set");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHOOSE_PAGE_CONTENT = await fs.readFile(
  path.join(__dirname, "choose.html"),
  "utf8",
);

const WHATSAPP_BLOCK = `      <a id="wa-link" class="app" href="{WHATSAPP_LINK}">
        <img
          src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg"
          alt=""
        />
        <span class="label">WhatsApp</span>
      </a>`;

const TELEGRAM_BLOCK = `      <a id="tg-link" class="app" href="{TELEGRAM_LINK}">
        <img
          src="https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg"
          alt=""
        />
        <span class="label">Telegram</span>
      </a>`;

const MATRIX_BLOCK = `      <a id="mx-link" class="app" href="{MATRIX_LINK}">
        <img
          src="https://upload.wikimedia.org/wikipedia/commons/1/13/Element_%28software%29_logo_%282024%29.svg"
          alt=""
        />
        <span class="label">Matrix</span>
      </a>`;

const TCHAP_BLOCK = `      <a id="mx-link" class="app" href="{TCHAP_LINK}">
        <img
          src="https://www.tchap.gouv.fr/themes/tchap/img/logos/tchap-logo.svg"
          alt=""
        />
        <span class="label">Matrix</span>
      </a>`;

const APP_URL = `http${isDev ? "" : "s"}://${APP_DOMAIN}`;
const APP_URL_WITH_PORT = `${APP_URL}:${String(appPort)}`;
const APP_URL_WITH_PORT_QR = APP_URL_WITH_PORT + "/qrcode";

const FRAME_PATH = path.join(__dirname, "frame.png");
const FONT_PATH = path.join(__dirname, "DejaVuSans-Bold.ttf");
const FONT_BASE64 = await fs.readFile(FONT_PATH, { encoding: "base64" });
const FONT_FAMILY = "JoelSans";

const FONTCONFIG_FILE_PATH = path.join(__dirname, "fontconfig.conf");
if (process.env.FONTCONFIG_FILE === undefined) {
  try {
    await fs.access(FONTCONFIG_FILE_PATH);
  } catch {
    const fontConfig = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${path.dirname(
      FONT_PATH,
    )}</dir>\n</fontconfig>\n`;
    await fs.writeFile(FONTCONFIG_FILE_PATH, fontConfig, "utf8");
  }
  process.env.FONTCONFIG_FILE = FONTCONFIG_FILE_PATH;
}

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
    let verifyOnJORFSearch = true;
    if (req.query.verify != undefined)
      verifyOnJORFSearch = Boolean(req.query.verify);

    // Type of follow: name, function_tag, organisation
    let followType: FollowType | undefined;

    // name for people
    const name = (req.query.name ?? "") as string;
    if (name.length > 0) {
      if (name.split(" ").length < 2)
        return res.status(400).json({
          error:
            "Name parameter must be composed two words minimum: firstname lastname.",
        });
      followType = "people";
    }

    // organisation
    const organisation_id = (req.query.organisation_id ?? "") as string;
    if (organisation_id.length > 0) {
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

    let followLabel;
    let qr_url;
    switch (followType) {
      case "people": {
        let prenomNom = name;
        if (verifyOnJORFSearch) {
          const JORFResult = await callJORFSearchPeople(name);
          if (JORFResult.length === 0)
            return res.status(400).json({
              error: `No result found on JORFSearch for person "${name}".`,
            });
          prenomNom = `${JORFResult[0].prenom} ${JORFResult[0].nom}`;
        }
        qr_url = `${APP_URL_WITH_PORT}?name=${prenomNom}`;
        followLabel = prenomNom;
        break;
      }

      case "organisation": {
        if (!verifyOnJORFSearch && !organisation_id.startsWith("Q"))
          return res.status(400).json({
            error:
              "Verification is mandatory when fetching organisation with WikidataId.",
          });
        if (verifyOnJORFSearch) {
          const JORFResult =
            await callJORFSearchOrganisationByWikidataId(organisation_id);
          if (JORFResult.length === 0)
            return res.status(400).json({
              error: `No result found on JORFSearch for organisation "${organisation_id}".`,
            });
          if (JORFResult.length > 1)
            return res
              .status(400)
              .json({ error: "Too many results found on JORFSearch." });
          qr_url = `${APP_URL_WITH_PORT}?&organisation=${organisation_id}`;
          followLabel = JORFResult[0].name;
        }
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
        qr_url = `${APP_URL_WITH_PORT}?&function_tag=${function_tag}`;
        followLabel = function_tag;
        break;
      }
    }
    if (!qr_url)
      return res.status(400).json({
        error: "qr_url not initialized",
      });

    const qrBuffer = await generateQrWithLogo(encodeURI(qr_url));

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
      <defs>
        <style>
          @font-face {
            font-family: '${FONT_FAMILY}';
            src: url('data:font/ttf;base64,${FONT_BASE64}') format('truetype');
            font-weight: 700;
            font-style: normal;
          }

          .label {
            font-family: '${FONT_FAMILY}', sans-serif;
            font-weight: 700;
            font-size: ${String(FONT_SIZE)};
            fill: ${TEXT_COLOR};
          }
        </style>
      </defs>

      <text x="50%" y="70%" dominant-baseline="middle" text-anchor="middle" class="label" ${
        followLabel ? "" : 'style="display: none;"'
      }>
        ${followLabel ?? ""}
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
        await umami.log({ event: "/qr-people" });
        break;
      case "organisation":
        await umami.log({ event: "/qr-organisation" });
        break;
      case "function_tag":
        await umami.log({ event: "/qr-tag" });
        break;
    }
  } catch (err) {
    console.error("QR API error:", err);
    res.status(500).json({ error: "QR code generation failed." });
  }
});

app.get("/", async (req, res) => {
  try {
    let content = CHOOSE_PAGE_CONTENT;

    const paramsNames = [
      "name",
      "organisation",
      "function_tag",
      "people",
      "verify",
    ];

    const paramsWithValues: string[] = [];
    paramsNames.forEach((param) => {
      const paramValue = (req.query[param] ?? "") as string;
      if (paramValue.length > 0)
        paramsWithValues.push(`${param}=${paramValue}`);
    });
    paramsWithValues.push("frame=false");

    let followType: FollowType | undefined;
    let followArg = null; // to be sent to the start command

    let qr_url: string | null = null;

    let verifyOnJORFSearch = true;
    if (req.query.verify != undefined)
      verifyOnJORFSearch = Boolean(req.query.verify);

    if (req.query.name != undefined) {
      followArg = req.query.name as string;
      if (followArg.split(" ").length < 2)
        return res.status(400).json({
          error:
            "Name parameter must be composed two words minimum: firstname lastname.",
        });
      followType = "people";

      if (verifyOnJORFSearch) {
        const JORFResult = await callJORFSearchPeople(followArg);
        if (JORFResult.length === 0)
          return res.status(400).json({
            error: `No result found on JORFSearch for person "${followArg}".`,
          });
        followArg = `${JORFResult[0].prenom} ${JORFResult[0].nom}`;
        qr_url = APP_URL_WITH_PORT_QR + "?name=" + followArg;
      }
    }

    if (req.query.organisation_id != undefined) {
      followArg = (req.query.organisation_id as string).toUpperCase();
      if (followType != undefined)
        return res.status(400).json({
          error:
            "Parameters people, function_tag and organisations are exclusive.",
        });
      if (!verifyOnJORFSearch && followArg.startsWith("Q")) {
        return res.status(400).json({
          error:
            "Verification is mandatory when fetching organisation with WikidataId.",
        });
      }
      if (verifyOnJORFSearch) {
        const JORFResult =
          await callJORFSearchOrganisationByWikidataId(followArg);
        if (JORFResult.length === 0)
          return res.status(400).json({
            error: `No result found on JORFSearch for organisation "${followArg}".`,
          });
        if (JORFResult.length > 1)
          return res
            .status(400)
            .json({ error: "Too many results found on JORFSearch." });
        followArg = JORFResult[0].id;
      }
      followType = "organisation";

      qr_url = APP_URL_WITH_PORT_QR + "?organisation=" + followArg;
    }

    if (req.query.function_tag != undefined) {
      followArg = req.query.function_tag as string;
      if (followType != undefined)
        return res.status(400).json({
          error:
            "Parameters people, function_tag and organisations are exclusive.",
        });
      followType = "function_tag";
      qr_url = APP_URL_WITH_PORT_QR + "?function_tag=" + followArg;
    }

    if (!qr_url)
      return res.status(400).json({
        error: "qr_url not initialized",
      });
    content = content.replace("{QR_URL}", encodeURI(qr_url + "&frame=false"));

    // Hide the QR code if already on mobile
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        req.get("user-agent") ?? "",
      );
    content = content.replace("{HIDDEN_QR}", isMobile ? "hidden" : "");

    // Show the display name
    content = content.replace(
      "{FOLLOW_LABEL}",
      followArg
        ? `Suivez <b>${followArg}</b> sur votre messagerie préférée:`
        : `Ouvrez 
                <span class="text-blue-500 font-['Rampart_One']">JO</span><span class="text-red-500 font-['Rampart_One']">ÉL</span>
               sur votre messagerie préférée:`,
    );

    // Show the display name
    content = content.replace("{BASE_URL}", APP_URL_WITH_PORT);

    content = content.replace(
      "{PAGE_TITLE}",
      followArg
        ? PAGE_TITLE_WITH_NAME.replace("{NAME}", followArg)
        : PAGE_TITLE_DEFAULT,
    );

    let startCommand = null;

    followArg ??= ""; // for the TypeScript check only
    switch (followType) {
      case "people":
        startCommand = "Rechercher " + followArg;
        await umami.log({ event: "/link-people" });
        break;
      case "organisation":
        startCommand = "SuivreO " + followArg;
        await umami.log({ event: "/link-organisation" });
        break;
      case "function_tag":
        startCommand = "SuivreF " + followArg;
        await umami.log({ event: "/link-tag" });
        break;

      default:
        await umami.log({ event: "/link-default" });
        res.redirect(encodeURI("https://" + HOME_WEBSITE_URL));
        return;
    }

    const smoothFlowCommand = startCommand.replace("Suivre", "Rechercher"); // flow is prettier with "Rechercher"

    content = content.replace(
      "{WHATSAPP_BLOCK}",
      hasWhatsapp ? WHATSAPP_BLOCK : "",
    );
    content = content.replace(
      "{TELEGRAM_BLOCK}",
      hasTelegram ? TELEGRAM_BLOCK : "",
    );
    content = content.replace("{MATRIX_BLOCK}", hasMatrix ? MATRIX_BLOCK : "");

    content = content.replace("{TCHAP_BLOCK}", hasTchap ? TCHAP_BLOCK : "");

    if (whatsappLinkBase) {
      const whatsappLink = encodeURI(
        `${whatsappLinkBase} ${smoothFlowCommand}`,
      );
      content = content.replace("{WHATSAPP_LINK}", whatsappLink);
    }

    if (telegramLinkBase) {
      const telegramLink = encodeURI(
        `${telegramLinkBase} ${smoothFlowCommand}`,
      );
      content = content.replace("{TELEGRAM_LINK}", telegramLink);
    }

    if (matrixLinkBase) {
      content = content.replace("{MATRIX_LINK}", matrixLinkBase);
    }

    if (tchapLinkBase) {
      content = content.replace("{TCHAP_LINK}", tchapLinkBase);
    }

    res.type("html").send(content);
  } catch (err) {
    console.error("QR API error:", err);
    res.status(500).json({ error: "Page generation failed." });
  }
});

app.get("/whatsapp", (req, res) => {
  if (whatsappLinkBase == null) {
    res.redirect(HOME_WEBSITE_URL);
    return;
  }
  res.redirect(encodeURI(whatsappLinkBase));
});

app.get("/matrix", (req, res) => {
  if (matrixLinkBase == null) {
    res.redirect(HOME_WEBSITE_URL);
    return;
  }
  res.redirect(encodeURI(matrixLinkBase));
});

app.get("/tchap", (req, res) => {
  if (tchapLinkBase == null) {
    res.redirect(HOME_WEBSITE_URL);
    return;
  }
  res.redirect(encodeURI(tchapLinkBase));
});

app.get("/telegram", (req, res) => {
  if (telegramLinkBase == null) {
    res.redirect(HOME_WEBSITE_URL);
    return;
  }
  res.redirect(encodeURI(telegramLinkBase));
});

app.get("/signal", (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (signalLinkBase == null) {
    res.redirect(HOME_WEBSITE_URL);
    return;
  }
  res.redirect(encodeURI(signalLinkBase));
});

app.get("/status", (req, res) => {
  res.type("text/plain").send("JOEL QR server is running.");
});

app.listen(PORT, () => {
  console.log(`📱 Try: ${APP_URL_WITH_PORT}`);
});

console.log(`QR: JOEL gateway started successfully \u{2705}`);

async function generateQrWithLogo(
  qr_url: string,
  {
    qrSize = 600,
    margin = 1,
    dark = "#000000",
    light = "#ffffff",
    logoPath = path.resolve(__dirname, "logo_round.png"),
    logoScale = 0.45, // slightly smaller without a white plate
  } = {},
) {
  // 1) QR buffer
  const qrBuffer = await QRCode.toBuffer(encodeURI(qr_url), {
    errorCorrectionLevel: "H",
    type: "png",
    width: qrSize,
    margin,
    color: { dark, light },
  });

  // 2) Transparent logo buffer at target size (keep alpha!)
  const targetLogoWidth = Math.floor(qrSize * logoScale);
  const logoBuf = await sharp(logoPath)
    .resize({ width: targetLogoWidth, fit: "inside" })
    .png() // preserve transparency
    .toBuffer();

  const logoMeta = await sharp(logoBuf).metadata();

  // 3) Center the logo directly onto the QR
  const left = Math.floor((qrSize - logoMeta.width) / 2);
  const top = Math.floor((qrSize - logoMeta.height) / 2);

  return await sharp(qrBuffer)
    .composite([{ input: logoBuf, left, top }]) // no background
    .png()
    .toBuffer();
}
