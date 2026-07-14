import * as flatbuffers from "flatbuffers";
import WeatherKit2 from "../class/WeatherKit2.mjs";

const SECTION_SLOTS = Object.freeze({
    airQuality: 0,
    currentWeather: 1,
    forecastDaily: 2,
    forecastHourly: 3,
    forecastNextHour: 4,
    news: 5,
    weatherAlerts: 6,
    weatherChanges: 7,
    historicalComparisons: 8,
    locationInfo: 9,
});

const align = (value, alignment) => Math.ceil(value / alignment) * alignment;

function isPlausibleTable(view, target) {
    if (target < 4 || target + 4 > view.byteLength) return false;
    const vtable = target - view.getInt32(target, true);
    if (vtable < 0 || vtable + 4 > view.byteLength) return false;
    const vtableLength = view.getUint16(vtable, true);
    const objectLength = view.getUint16(vtable + 2, true);
    return vtableLength >= 4 && vtableLength <= 512 && objectLength >= 4 && target + objectLength <= view.byteLength;
}

function readRoot(rawBody) {
    const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 8) throw new Error("Weather FlatBuffer is too short");

    const root = view.getUint32(0, true);
    if (root < 4 || root + 4 > view.byteLength) throw new Error("Invalid Weather root offset");
    const vtable = root - view.getInt32(root, true);
    if (vtable < 0 || vtable + 4 > view.byteLength) throw new Error("Invalid Weather vtable offset");

    const vtableLength = view.getUint16(vtable, true);
    if (vtableLength < 4 || vtable + vtableLength > view.byteLength || (vtableLength - 4) % 2 !== 0) {
        throw new Error("Invalid Weather vtable length");
    }

    const fieldCount = (vtableLength - 4) / 2;
    const fields = Array.from({ length: fieldCount }, (_, slot) => {
        const offset = view.getUint16(vtable + 4 + slot * 2, true);
        if (!offset) return null;
        const position = root + offset;
        if (position + 4 > view.byteLength) throw new Error(`Weather field ${slot} is out of bounds`);
        const target = position + view.getUint32(position, true);
        // WK2.Weather contains table offsets. Refuse an unknown scalar layout instead
        // of returning a corrupt response when Apple changes the schema again.
        if (!isPlausibleTable(view, target)) throw new Error(`Weather field ${slot} is not a table offset`);
        return target;
    });

    return { bytes, fieldCount, fields };
}

function encodeSection(section, data) {
    const builder = new flatbuffers.Builder();
    const offset = WeatherKit2.encode(builder, section, data);
    if (!offset) throw new Error(`Unable to encode Weather section: ${section}`);
    builder.finish(offset);
    const encoded = builder.asUint8Array();
    const bytes = new Uint8Array(encoded);
    const root = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    return { bytes, root };
}

/**
 * Replaces selected child tables while preserving the original WK2.Weather
 * buffer, including fields unknown to the bundled schema.
 */
export default function patchWeatherFlatBuffer(rawBody, weather, changedSections) {
    const original = readRoot(rawBody);
    const replacements = [];

    for (const section of changedSections) {
        const slot = SECTION_SLOTS[section];
        if (slot === undefined || weather?.[section] == null) continue;
        replacements.push({ section, slot, ...encodeSection(section, weather[section]) });
    }
    if (!replacements.length) return original.bytes;

    const fieldCount = Math.max(original.fieldCount, ...replacements.map(item => item.slot + 1));
    const vtablePosition = 4;
    const vtableLength = 4 + fieldCount * 2;
    const rootPosition = align(vtablePosition + vtableLength, 4);
    const objectLength = 4 + fieldCount * 4;
    const prefixLength = align(rootPosition + objectLength, 8);

    let cursor = align(prefixLength + original.bytes.length, 8);
    for (const replacement of replacements) {
        replacement.position = cursor;
        cursor = align(cursor + replacement.bytes.length, 8);
    }

    const output = new Uint8Array(cursor);
    output.set(original.bytes, prefixLength);
    for (const replacement of replacements) output.set(replacement.bytes, replacement.position);

    const view = new DataView(output.buffer);
    view.setUint32(0, rootPosition, true);
    view.setUint16(vtablePosition, vtableLength, true);
    view.setUint16(vtablePosition + 2, objectLength, true);
    view.setInt32(rootPosition, rootPosition - vtablePosition, true);

    const replacementBySlot = new Map(replacements.map(item => [item.slot, item]));
    for (let slot = 0; slot < fieldCount; slot++) {
        const replacement = replacementBySlot.get(slot);
        const originalTarget = original.fields[slot];
        if (!replacement && originalTarget == null) continue;

        const fieldOffset = 4 + slot * 4;
        const fieldPosition = rootPosition + fieldOffset;
        const target = replacement ? replacement.position + replacement.root : prefixLength + originalTarget;
        if (target <= fieldPosition) throw new Error(`Weather field ${slot} does not point forward`);
        view.setUint16(vtablePosition + 4 + slot * 2, fieldOffset, true);
        view.setUint32(fieldPosition, target - fieldPosition, true);
    }

    return output;
}
