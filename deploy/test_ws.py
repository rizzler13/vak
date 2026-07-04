import asyncio
import websockets
import json

async def test():
    uri = "ws://52.86.214.242:8000/ws/voice?session_id=localtest"
    print(f"Connecting to {uri}...")
    try:
        async with websockets.connect(uri) as websocket:
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
