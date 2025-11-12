import axios, { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import umami from "./umami.ts";

// Extend the InternalAxiosRequestConfig with the res field
interface CustomInternalAxiosRequestConfig extends InternalAxiosRequestConfig {
  res?: {
    responseUrl?: string;
  };
}

interface JORFSearchItemRaw {
  prenom?: string;
  nom?: string;
}
interface JORFSearchItem extends JORFSearchItemRaw {
  prenom: string;
  nom: string;
}

type JORFSearchResponse = null | string | JORFSearchItemRaw[];

type WikidataId = string;

export async function callJORFSearchPeople(
  peopleName: string,
): Promise<JORFSearchItem[]> {
  try {
    await umami.log({ event: "/jorfsearch-request-people" });
    return await axios
      .get<JORFSearchResponse>(
        encodeURI(
          `https://jorfsearch.steinertriples.ch/name/${
            cleanPeopleNameJORFURL(peopleName) // Cleaning the string reduces the number of calls to JORFSearch
          }?format=JSON`,
        ),
      )
      .then(async (res1: AxiosResponse<JORFSearchResponse>) => {
        if (res1.data === null) return []; // If an error occurred
        if (typeof res1.data !== "string") return cleanJORFItems(res1.data); // If it worked

        const request = res1.request as CustomInternalAxiosRequestConfig;

        // If the peopleName had nom/prenom inverted or bad formatting:
        // we need to call JORFSearch again with the response url in the correct format
        if (request.res?.responseUrl) {
          await umami.log({ event: "/jorfsearch-request-people-formatted" });
          return await axios
            .get<JORFSearchResponse>(
              request.res.responseUrl.endsWith("?format=JSON")
                ? request.res.responseUrl
                : `${request.res.responseUrl}?format=JSON`,
            )
            .then((res2: AxiosResponse<JORFSearchResponse>) => {
              if (res2.data === null || typeof res2.data === "string") {
                return [];
              }
              return cleanJORFItems(res2.data);
            });
        }
        return [];
      });
  } catch (error) {
    console.log(error);
    return [];
  }
}

export async function callJORFSearchTag(
  tag: string,
  tagValue?: string,
): Promise<JORFSearchItem[]> {
  try {
    await umami.log({ event: "/jorfsearch-request-tag" });
    return await axios
      .get<JORFSearchResponse>(
        encodeURI(
          `https://jorfsearch.steinertriples.ch/tag/${tag}${
            tagValue !== undefined ? `="${tagValue}"` : ``
          }?format=JSON`,
        ),
      )
      .then((res) => {
        if (res.data === null || typeof res.data === "string") return [];
        return cleanJORFItems(res.data);
      });
  } catch (error) {
    console.log(error);
  }
  return [];
}

export function cleanPeopleNameJORFURL(input: string): string {
  if (!input) return "";

  // 1. Trim & lowercase
  let out = input.trim().toLowerCase();

  // 2. Strip common Western diacritics in one shot
  out = out.replace(/[\u0300-\u036f]/g, ""); // remove combining marks

  // 3. Capitalise first letter after start, space, hyphen or apostrophe
  //    - keeps the delimiter (p1) and upper-cases the following char (p2)
  out = out.replace(/(^|[\s\-'])\p{L}/gu, (m) => m.toUpperCase());

  out = out.replace(/[()]/g, "");

  return out;
}

export async function callJORFSearchOrganisationByWikidataId(
  wikidataId: WikidataId,
): Promise<{ name: string; id: WikidataId }[]> {
  try {
    return await axios
      .get<
        { name: string; id: WikidataId }[]
      >(encodeURI(`https://jorfsearch.steinertriples.ch/wikidata_id_to_name?ids[]=${wikidataId}`))
      .then((r) => {
        return r.data;
      });
  } catch (error) {
    console.log(error);
  }
  return [];
}

function cleanJORFItems(raw_items: JORFSearchItemRaw[]): JORFSearchItem[] {
  return raw_items.reduce((tab: JORFSearchItem[], raw_item) => {
    if (raw_item.nom != undefined && raw_item.prenom != undefined)
      tab.push(raw_item as JORFSearchItem);
    return tab;
  }, []);
}
