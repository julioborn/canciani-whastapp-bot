const mongoose = require("mongoose");

const ProductoSchema = new mongoose.Schema(
    {
        nombre: { type: String, required: true, trim: true },
        nombrePlural: { type: String }, // 👈 nuevo
        genero: {
            type: String,
            enum: ["masculino", "femenino"],
            default: "masculino",
        },

        descripcion: { type: String, default: "" },
        precioKg: { type: Number, required: true, min: 0 },
        stock: { type: Number, required: true, min: 0 },

        requiereTurno: { type: Boolean, default: false },
        activo: { type: Boolean, default: true },
    },
    { timestamps: true }
);

ProductoSchema.index({ nombre: 1 }, { unique: true });

module.exports =
    mongoose.models.Producto || mongoose.model("Producto", ProductoSchema);