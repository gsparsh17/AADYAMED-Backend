import axios from "axios";

export const searchLocation = async (query) => {
  const res = await axios.get(
    `https://nominatim.openstreetmap.org/search`,
    {
      params: {
        q: query,
        format: "json",
        limit: 5
      }
    }
  );

  return res.data;
};