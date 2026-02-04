const { Schema, model } = require("mongoose");

const ConfigSchema = new Schema({
    botActivo: {
        type: Boolean,
        default: true,
    },
    mensajeCerrado: {
        type: String,
        default: "🚫 Hoy no hay pedidos disponibles. Volvé a escribir más tarde.",
    },
});

module.exports = model("Config", ConfigSchema);
