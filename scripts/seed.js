require("dotenv").config();
const connectMongo = require("../db/mongo");

const Config = require("../models/Config");
const Stock = require("../models/Stock");
const Horario = require("../models/Horario");

async function seed() {
    await connectMongo();

    await Config.deleteMany();
    await Stock.deleteMany();
    await Horario.deleteMany();

    await Config.create({
        botActivo: true,
        mensajeCerrado: "🚫 Hoy no hay pedidos disponibles. Volvé a escribir más tarde."
    });

    await Stock.create({
        producto: "Media res",
        precio: 120000,
        disponible: 10
    });

    await Horario.create([
        { fecha: "2026-01-25", hora: "09:00" },
        { fecha: "2026-01-25", hora: "10:30" },
        { fecha: "2026-01-25", hora: "12:00" }
    ]);

    console.log("✅ Seed ejecutado correctamente");
    process.exit();
}

seed();
