import { ARMY_ADJ, FLEET_ADJ, PROVINCES } from "../lib/game/map-data.ts";
console.log("par army:", ARMY_ADJ.par);
console.log("mar army:", ARMY_ADJ.mar);
console.log("bre fleet:", FLEET_ADJ.bre);
console.log("stp/sc fleet:", FLEET_ADJ["stp/sc"]);
console.log("mao fleet:", FLEET_ADJ.mao);
console.log("ber army:", ARMY_ADJ.ber);
console.log("spa coasts:", PROVINCES.spa.coasts, "stp scPos:", PROVINCES.stp.scPos);
