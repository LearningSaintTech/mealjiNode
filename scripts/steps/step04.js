// Step 04 · Location and addresses — Location, Addresses, Add new address, Update address screens.
import { Client, createSuite, DEMO, newCustomer, POINTS } from "./harness.js";

export default async function step04(ctx) {
  const s = createSuite("04", "Location and addresses");
  const nc = await newCustomer(ctx);
  const app = nc.client;

  await s.run("04-01", "“Use current location” in a served area", "Location: “Do we deliver to you?” → yes", async () => {
    const res = await app.call("PUT", "/users/me/location", POINTS.served);
    const sv = res.data?.serviceability || {};
    return { ok: res.status === 200 && sv.serviceable === true && sv.kitchen?.kitchenId && sv.etaLabel && res.data?.city, detail: `${res.status} ${sv.kitchen?.name} ${sv.etaLabel} ${res.data?.city}` };
  });
  await s.run("04-02", "“Use current location” outside the area says so", "Location: not delivered here", async () => {
    const res = await app.call("PUT", "/users/me/location", POINTS.notServed);
    const sv = res.data?.serviceability || {};
    await app.call("PUT", "/users/me/location", POINTS.served);
    return { ok: res.status === 200 && sv.serviceable === false && sv.reason === "not_serviceable" && sv.message, detail: `${sv.reason}: ${sv.message}` };
  });
  await s.run("04-03", "Saved location comes back", "Home “Deliver to” after relaunch", async () => {
    const res = await app.call("GET", "/users/me/location");
    return { ok: res.status === 200 && Math.abs(res.data?.latitude - POINTS.served.latitude) < 0.0001, detail: `${res.status} ${res.data?.locationText}` };
  });
  await s.run("04-04", "Delivery check by point and by pincode; bad input refused", "Location search and pincode entry", async () => {
    const point = await app.call("GET", `/serviceability?latitude=${POINTS.served.latitude}&longitude=${POINTS.served.longitude}`);
    const pin = await app.call("GET", "/serviceability/pincode/560095");
    const badPin = await app.call("GET", "/serviceability/pincode/5600");
    const badPoint = await app.call("GET", "/serviceability?latitude=999&longitude=1");
    return { ok: point.data?.serviceable === true && pin.data?.serviceable === true && badPin.status === 422 && badPoint.status === 422, detail: `${point.status}/${pin.status}/${badPin.status}/${badPoint.status}` };
  });
  await s.run("04-05", "Place search, then the picked place with its delivery check", "Location: search box → tap a suggestion", async () => {
    const token = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    const res = await app.call("GET", `/geo/autocomplete?input=Koramangala&latitude=12.93&longitude=77.62&sessionToken=${token}`);
    const first = res.data?.[0];
    const place = first ? await app.call("GET", `/geo/place/${first.placeId}?sessionToken=${token}`) : null;
    const bad = await app.call("GET", "/geo/place/notARealPlaceId123");
    return {
      ok: res.status === 200 && first?.primaryText && place?.status === 200 && Number.isFinite(place.data?.latitude) && typeof place.data?.serviceability?.serviceable === "boolean" && bad.status === 404,
      detail: `${res.status} ${res.data?.length} suggestions · “${first?.primaryText}” → ${place?.status} ${place?.data?.city} serviceable ${place?.data?.serviceability?.serviceable} · bad id ${bad.status}`,
    };
  });

  // Addresses as the app's Add new address form sends them: no map pin.
  let first;
  await s.run("04-06", "Add address from the form (no map pin), label “Office”", "Add new address: Full name, Phone, Pincode, House/Flat, Landmark, City, State; chips Home/Office/Other", async () => {
    const res = await app.call("POST", "/users/me/addresses", { label: "Office", recipientName: "Test Newcomer", phone: "9000000099", houseFlat: "3rd Floor, 80 Feet Road", landmark: "Near Sony Signal", city: "Bengaluru", state: "Karnataka", pincode: "560034" });
    first = res.data;
    return { ok: res.status === 201 && res.data?.label === "work" && res.data?.displayLabel === "Office" && Number.isFinite(res.data?.latitude) && res.data?.serviceable === true, detail: `${res.status} ${res.message} label ${res.data?.label}/${res.data?.displayLabel} coords ${res.data?.latitude},${res.data?.longitude} serviceable ${res.data?.serviceable}` };
  });
  await s.run("04-07", "First address becomes the default", "Addresses: the first saved address is selected", () => ({ ok: first?.isDefault === true, detail: String(first?.isDefault) }));
  let second;
  await s.run("04-08", "Custom label like “Parents' Home” is kept", "Addresses list shows “Parents' Home”", async () => {
    const res = await app.call("POST", "/users/me/addresses", { label: "Other", customLabel: "Parents' Home", houseFlat: "No. 14, 2nd Floor", street: "17th Main, 3rd Block", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", latitude: 12.9346, longitude: 77.6311 });
    second = res.data;
    return { ok: res.status === 201 && res.data?.displayLabel === "Parents' Home" && res.data?.isDefault === false, detail: `${res.status} ${res.data?.displayLabel}` };
  });
  await s.run("04-09", "Missing house/flat or a 5-digit pincode is refused", "Add new address validation", async () => {
    const noHouse = await app.call("POST", "/users/me/addresses", { city: "Bengaluru", pincode: "560034" });
    const shortPin = await app.call("POST", "/users/me/addresses", { houseFlat: "12", city: "Bengaluru", pincode: "56003" });
    return { ok: noHouse.status === 422 && shortPin.status === 422, detail: `${noHouse.status}/${shortPin.status}` };
  });
  await s.run("04-10", "An address nobody can place is refused clearly", "Add new address: wrong pincode/city", async () => {
    const res = await app.call("POST", "/users/me/addresses", { houseFlat: "1", city: "Nowhere", pincode: "000000" });
    return { ok: res.status === 422, detail: `${res.status} ${res.message} ${JSON.stringify(res.errors)}` };
  });
  await s.run("04-11", "Address list: default first, with label, full address and delivery check", "Addresses screen", async () => {
    const res = await app.call("GET", "/users/me/addresses");
    const list = res.data || [];
    return { ok: res.status === 200 && list.length === 2 && list[0].isDefault && list.every((a) => a.addressId && a.displayLabel && a.fullAddress && typeof a.serviceable === "boolean"), detail: list.map((a) => `${a.displayLabel}${a.isDefault ? "*" : ""}`).join(", ") };
  });
  await s.run("04-12", "Edit an address", "Update address screen", async () => {
    const res = await app.call("PATCH", `/users/me/addresses/${second?.addressId}`, { landmark: "Opposite Forum Mall", recipientName: "Mom" });
    return { ok: res.status === 200 && res.data?.landmark === "Opposite Forum Mall", detail: `${res.status}` };
  });
  await s.run("04-13", "Make another address the default (only one default)", "Addresses: choose delivery address", async () => {
    const res = await app.call("PATCH", `/users/me/addresses/${second?.addressId}/default`);
    const list = (await app.call("GET", "/users/me/addresses")).data || [];
    return { ok: res.status === 200 && list.filter((a) => a.isDefault).length === 1 && list[0].addressId === second?.addressId, detail: list.map((a) => `${a.displayLabel}${a.isDefault ? "*" : ""}`).join(", ") };
  });
  await s.run("04-14", "Another customer cannot touch my address", "Security", async () => {
    const other = new Client("step04-device-002");
    await other.signIn(DEMO.otherCustomer);
    const edit = await other.call("PATCH", `/users/me/addresses/${second?.addressId}`, { landmark: "x" });
    const del = await other.call("DELETE", `/users/me/addresses/${second?.addressId}`);
    return { ok: edit.status === 404 && del.status === 404, detail: `${edit.status}/${del.status}` };
  });
  await s.run("04-15", "Delete the default: another address takes over", "Addresses: Delete", async () => {
    const res = await app.call("DELETE", `/users/me/addresses/${second?.addressId}`);
    const list = (await app.call("GET", "/users/me/addresses")).data || [];
    const again = await app.call("DELETE", `/users/me/addresses/${second?.addressId}`);
    return { ok: res.status === 200 && list.length === 1 && list[0].isDefault === true && again.status === 404, detail: `${res.status} remaining ${list.length} default ${list[0]?.isDefault} again ${again.status}` };
  });
  return s;
}
