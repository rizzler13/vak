import asyncio
import websockets
import json

async def test():
    uri = "wss://d3f5ad0ivrina5.cloudfront.net/ws/voice?session_id=localtest"
    print(f"Connecting to {uri}...")
    import ssl
    ssl_context = ssl._create_unverified_context()
    try:
        async with websockets.connect(uri, ssl=ssl_context) as websocket:
            print("Connected successfully!")
            # Receive session_init
            msg1 = await websocket.recv()
            print(f"Received: {msg1[:200]}...")
            
            # Receive opening transcript (if any)
            msg2 = await websocket.recv()
            print(f"Received: {msg2[:200]}...")
            
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(test())
