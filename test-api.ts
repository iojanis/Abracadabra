// Simple test script to check the /api/documents/ endpoint

async function testDocumentsAPI() {
  try {
    console.log("Testing /api/documents/ endpoint...");

    const response = await fetch("http://localhost:8787/api/documents/", {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    console.log("Response status:", response.status);
    console.log("Response headers:", Object.fromEntries(response.headers.entries()));

    const text = await response.text();
    console.log("Response body:", text);

    if (response.ok) {
      try {
        const json = JSON.parse(text);
        console.log("Parsed JSON:", JSON.stringify(json, null, 2));
      } catch (e) {
        console.log("Response is not valid JSON");
      }
    }

    console.log("✅ Test completed");

  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

if (import.meta.main) {
  testDocumentsAPI();
}
