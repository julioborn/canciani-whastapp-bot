const { Schema, model } = require("mongoose");

const StockSchema = new Schema({
    producto: {
        type: String,
        default: "Media res",
    },
    precio: {
        type: Number,
        required: true,
    },
    disponible: {
        type: Number,
        required: true,
    },
});

module.exports = model("Stock", StockSchema);
