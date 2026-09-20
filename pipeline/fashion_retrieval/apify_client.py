# apify_client.py 負責「把 Instagram URL 丟給 Apify，拿回原始 JSON 

"""
apify_client.py

Purpose
-------
Send an Instagram Post / Reel URL to Apify and return
the raw Instagram data returned by the Apify actor.

Input
-----
Instagram URL (str)

Output
------
Raw Instagram data (dict)
"""

import os

from apify_client import ApifyClient
from dotenv import load_dotenv


# ============================================================
# Configuration
# ============================================================

load_dotenv()

APIFY_TOKEN = os.getenv("APIFY_TOKEN")

ACTOR_ID = "apify/instagram-post-scraper"


# ============================================================
# Public API
# ============================================================

def fetch_instagram_post(url: str) -> dict:
    """
    Fetch raw Instagram data from Apify.

    Parameters
    ----------
    url : str
        Instagram Post or Reel URL.

        Examples:
        https://www.instagram.com/p/XXXXXXXX/
        https://www.instagram.com/reel/XXXXXXXX/

    Returns
    -------
    dict
        Raw Instagram post data returned by Apify.

    Raises
    ------
    ValueError
        If the URL is empty.

    RuntimeError
        If APIFY_TOKEN is missing or Apify returns no result.
    """

    # --------------------------------------------------------
    # Validate input
    # --------------------------------------------------------

    if not url:
        raise ValueError("Instagram URL cannot be empty.")

    if not APIFY_TOKEN:
        raise RuntimeError(
            "APIFY_TOKEN is not set. "
            "Please add it to your .env file."
        )

    # --------------------------------------------------------
    # Initialize Apify
    # --------------------------------------------------------

    client = ApifyClient(APIFY_TOKEN)

    # --------------------------------------------------------
    # Actor input
    # --------------------------------------------------------

    run_input = {
        "username": [url],
        "resultsLimit": 1,
    }

    # --------------------------------------------------------
    # Run Actor
    # --------------------------------------------------------

    print(f"[Apify] Fetching: {url}")

    run = client.actor(ACTOR_ID).call(
        run_input=run_input
    )

    # --------------------------------------------------------
    # Get dataset
    # --------------------------------------------------------



    dataset_id = run.default_dataset_id

    dataset = client.dataset(dataset_id)
    items = dataset.list_items().items

    # --------------------------------------------------------
    # Validate result
    # --------------------------------------------------------

    if not items:
        raise RuntimeError(
            f"Apify returned no result for URL: {url}"
        )

    result = items[0]

    print(
        f"[Apify] Success: "
        f"{result.get('type')} / "
        f"{result.get('shortCode')}"
    )

    return result